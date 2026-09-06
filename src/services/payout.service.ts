import { type Payout } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import {
  AnchorApiError,
  createBookTransfer,
  createNipTransfer,
  getAccountBalance,
  getTransfer,
  verifyTransfer,
  TRANSFER_FAILURE,
  TRANSFER_SUCCESS,
} from '../lib/anchor';
import { notifyMany } from '../lib/notifications';

const STALE_PAYOUT_AFTER_MS = 15 * 60 * 1000;

/**
 * Kick off the Anchor NIP transfer for a freshly-created payout.
 *
 * The transfer is drawn from the space's OWN deposit account — under Anchor the
 * collections already landed there, so there is no platform balance in the
 * middle. `netSentKobo` and the fee columns were computed and stored when the
 * payout was requested (see computePayoutFees), so what the rep was shown in
 * the confirmation breakdown is exactly what is sent.
 *
 * Best-effort: if the account isn't ready or the call fails, the payout stays
 * `processing` for the reconciliation job to retry.
 */
export async function initiatePayoutDisbursement(payout: Payout): Promise<void> {
  const space = await db.space.findUnique({
    where: { id: payout.spaceId },
    select: { anchorAccountId: true, anchorCounterPartyId: true, payoutsFrozen: true },
  });
  if (!space?.anchorAccountId || !space.anchorCounterPartyId) return;
  if (space.payoutsFrozen) {
    console.error(`[payout] withdrawal skipped for ${payout.reference} — space payouts are frozen`);
    return;
  }
  if (payout.netSentKobo <= 0) {
    await settlePayout(payout.reference, false, 'The amount is too small to cover the withdrawal fees');
    return;
  }

  try {
    // Bachs had a per-capability grant we re-read before every disbursement.
    // Anchor has no equivalent, so the live check is the account's own balance —
    // the same discipline: never move money on cached state.
    const balance = await getAccountBalance(space.anchorAccountId);
    if (balance.availableBalance < payout.amount) {
      console.error(
        `[payout] withdrawal deferred for ${payout.reference} — Anchor balance ${balance.availableBalance} < ${payout.amount}`,
      );
      return;
    }

    const result = await createNipTransfer(
      {
        accountId: space.anchorAccountId,
        counterPartyId: space.anchorCounterPartyId,
        amountKobo: payout.netSentKobo,
        reference: payout.reference,
        reason: `Duevy payout ${payout.reference}`,
      },
      `wd-${payout.reference.toLowerCase()}`,
    );

    await db.payout.update({ where: { id: payout.id }, data: { anchorTransferId: result.id } });

    if (TRANSFER_SUCCESS.has(result.status)) {
      await settlePayout(payout.reference, true);
    } else if (TRANSFER_FAILURE.has(result.status)) {
      await settlePayout(payout.reference, false, result.failureReason ?? 'The payout was rejected by the bank');
    }
    // PENDING/PROCESSING/etc — leave `processing`; the nip.transfer.* webhook or
    // the reconciliation job resolves it.
  } catch (err) {
    console.error(`[payout] disbursement init failed for ${payout.reference}:`, err);
  }
}

/** Resolve a `processing` payout to `completed`/`failed`. Idempotent. */
export async function settlePayout(reference: string, success: boolean, failureReason?: string): Promise<void> {
  const payout = await db.payout.findUnique({ where: { reference } });
  if (!payout || payout.status !== 'processing') return;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.payout.update({
      where: { reference },
      data: success
        ? { status: 'completed', settledAt: new Date() }
        : { status: 'failed', failureReason: failureReason ?? 'The payout could not be completed' },
    });
    if (success) {
      await tx.ledgerEntry.create({
        data: {
          spaceId: u.spaceId,
          dueId: u.dueId,
          payoutId: u.id,
          type: 'payout',
          direction: 'debit',
          amountKobo: u.amount,
          grossKobo: u.amount,
          feeKobo: u.duevyFeeKobo + u.anchorFeeKobo + u.stampDutyKobo,
          netKobo: u.netSentKobo,
          reference: u.reference,
          description: `Payout to ${u.accountMasked}`,
        },
      });
    }
    return u;
  });

  // Duevy's cut of the withdrawal fee is still sitting in the space's account
  // (Anchor took only its own NIP fee and the stamp duty), so collect it.
  if (success && updated.duevyFeeKobo > 0) {
    await sweepPayoutFee(updated).catch((err) =>
      console.error(`[payout] fee sweep failed for ${updated.reference}:`, err),
    );
  }

  const reps = await db.spaceRep.findMany({ where: { spaceId: updated.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    success
      ? {
          kind: 'payout_completed',
          title: 'Payout completed',
          detail: `₦${(updated.netSentKobo / 100).toLocaleString('en-NG')} was sent to ${updated.accountMasked}.`,
          href: '/dashboard/payout',
        }
      : {
          kind: 'system',
          tone: 'rose',
          title: 'Payout failed',
          detail: `Your ₦${(updated.amount / 100).toLocaleString('en-NG')} payout could not be completed.`,
          href: '/dashboard/payout',
        },
  );
}

async function sweepPayoutFee(payout: Payout): Promise<void> {
  const space = await db.space.findUnique({ where: { id: payout.spaceId }, select: { anchorAccountId: true } });
  if (!space?.anchorAccountId) return;

  await createBookTransfer(
    {
      fromAccountId: space.anchorAccountId,
      toAccountId: env.ANCHOR_REVENUE_ACCOUNT_ID,
      amountKobo: payout.duevyFeeKobo,
      reference: `pfee-${payout.reference.toLowerCase()}`,
      reason: `Withdrawal fee ${payout.reference}`,
    },
    `pfee-${payout.reference.toLowerCase()}`,
  );
}

/** Poll Anchor for payouts that have sat in `processing` too long (reconciliation job). */
export async function reconcileStalePayouts(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_PAYOUT_AFTER_MS);
  const stale = await db.payout.findMany({
    where: { status: 'processing', requestedAt: { lte: staleThreshold } },
    take: 50,
  });

  for (const payout of stale) {
    // A payout with no transfer id never reached Anchor — retry the disbursement
    // rather than polling for something that was never created.
    if (!payout.anchorTransferId) {
      await initiatePayoutDisbursement(payout).catch((err) =>
        console.error(`[payout] retry failed for ${payout.reference}:`, err),
      );
      continue;
    }

    try {
      // verifyTransfer forces Anchor to re-query the provider; getTransfer only
      // reads its cached view, so it's the fallback.
      const status =
        (await verifyTransfer(payout.anchorTransferId)) ?? (await getTransfer(payout.anchorTransferId));
      if (!status) continue;
      if (TRANSFER_SUCCESS.has(status.status)) await settlePayout(payout.reference, true);
      else if (TRANSFER_FAILURE.has(status.status)) {
        await settlePayout(payout.reference, false, status.failureReason);
      }
    } catch (err) {
      console.error(`[payout] reconciliation failed for ${payout.reference}:`, err);
    }
  }
}

/**
 * The service-charge sweep — the inverse of the old Bachs split.
 *
 * Under Anchor the payer transfers straight into the space's own deposit
 * account, so the department's face value is already where it belongs. What has
 * to move is Duevy's share of the 2%.
 *
 * ONLY `duevyFee` IS SWEPT, NOT `processingFee + duevyFee`. Anchor charges its
 * own collection fee and stamp duty directly against the account as separate
 * CustomerFee rows, so `processingFee` has already left; sweeping it again
 * would take Anchor's cut twice out of the rep's money. If Anchor's actual
 * charge ever diverges from the estimate in computeCharge(), the difference
 * shows up as account drift for the nightly reconciliation to surface — not as
 * a shortfall in the rep's withdrawable balance, which is computed from our own
 * ledger rather than from Anchor.
 *
 * Runs per payment with a deterministic idempotency key, the same shape the old
 * split sweep used; on INSUFFICIENT_BALANCE (settlement lag) it simply waits
 * for the next tick.
 */
export async function sweepServiceCharges(): Promise<void> {
  const pending = await db.duePayment.findMany({
    where: { settledAt: { not: null }, sweptAt: null },
    include: { due: { include: { space: { select: { anchorAccountId: true } } } } },
    take: 50,
  });

  for (const payment of pending) {
    const accountId = payment.due.space.anchorAccountId;
    if (!accountId) continue; // space isn't provisioned — leave for a later tick

    // A fully discounted charge leaves Duevy nothing to collect; close it out
    // rather than re-selecting it forever.
    if (payment.duevyFee <= 0) {
      await db.duePayment.update({ where: { id: payment.id }, data: { sweptAt: new Date() } });
      continue;
    }

    try {
      const key = `swp-${payment.reference.toLowerCase()}`;
      const transfer = await createBookTransfer(
        {
          fromAccountId: accountId,
          toAccountId: env.ANCHOR_REVENUE_ACCOUNT_ID,
          amountKobo: payment.duevyFee,
          reference: key,
          reason: `Service charge ${payment.reference}`,
        },
        key,
      );
      await db.duePayment.update({
        where: { id: payment.id },
        data: { sweptAt: new Date(), anchorSweepTransferId: transfer.id },
      });
    } catch (err) {
      if (err instanceof AnchorApiError && err.isInsufficientBalance) continue;
      console.error(`[payout] service-charge sweep failed for ${payment.reference}:`, err);
    }
  }
}

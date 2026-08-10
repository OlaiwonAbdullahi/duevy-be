import { type Payout } from '@prisma/client';
import { db } from '../config/db';
import {
  BachsApiError,
  getConnectedAccountCapabilities,
  createTransfer,
  createWithdrawal,
  getWithdrawal,
} from '../lib/bachs';
import { notifyMany } from '../lib/notifications';

const STALE_PAYOUT_AFTER_MS = 15 * 60 * 1000;
// Funds clear 24h after payment, then become eligible for the split-transfer
// sweep below — same window computeBalances() used to gate "available" on
// directly; now "available" gates on transferredAt instead (see payouts.ts),
// so this constant only controls when the sweep fires.
const CLEARING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Who to notify a withdrawal's outcome to — the requester, falling back to the space's lead rep. */
async function resolveNotificationEmail(spaceId: string, payout: Payout): Promise<string | null> {
  if (payout.requestedById) {
    const user = await db.user.findUnique({ where: { id: payout.requestedById }, select: { email: true } });
    if (user) return user.email;
  }
  const lead = await db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: { select: { email: true } } } });
  return lead?.user.email ?? null;
}

/**
 * Kick off the actual Bachs withdrawal for a freshly-created payout (§10.3).
 * Called AS the connected account (X-Connected-Account-ID) — the withdrawal
 * draws from the department's own Bachs balance, funded by the split
 * transfers below. Capability is re-read live rather than trusting the
 * cached `bachsPayoutsActive` flag, per the skill's non-negotiable: never
 * trust a cached capability for a money-moving call. Best-effort: if the
 * account isn't ready or the call fails, the payout simply stays
 * `processing` for the reconciliation job to retry.
 */
export async function initiatePayoutDisbursement(payout: Payout): Promise<void> {
  const space = await db.space.findUnique({
    where: { id: payout.spaceId },
    select: { bachsAccountId: true, bachsPayoutDestinationId: true },
  });
  if (!space?.bachsAccountId || !space.bachsPayoutDestinationId) return;

  try {
    const capabilities = await getConnectedAccountCapabilities(space.bachsAccountId);
    if (capabilities.payouts?.status !== 'active') {
      console.error(`[payout] withdrawal skipped for ${payout.reference} — payouts capability not active`);
      return;
    }

    const email = await resolveNotificationEmail(payout.spaceId, payout);
    if (!email) return;

    const result = await createWithdrawal(
      space.bachsAccountId,
      {
        amountKobo: payout.amount,
        reference: payout.reference,
        email,
        payoutDestinationId: space.bachsPayoutDestinationId,
      },
      `WD-${payout.reference}`,
    );

    if (result.status === 'COMPLETED') {
      await settlePayout(payout.reference, true);
    } else if (result.status === 'FAILED' || result.status === 'REJECTED') {
      await settlePayout(payout.reference, false, 'The payout was rejected by the payment provider');
    }
    // REQUESTED/PENDING/APPROVED/PROCESSING — leave `processing`; the webhook or reconciliation job resolves it.
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
          reference: u.reference,
          description: `Payout to ${u.accountMasked}`,
        },
      });
    }
    return u;
  });

  const reps = await db.spaceRep.findMany({ where: { spaceId: updated.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    success
      ? {
          kind: 'payout_completed',
          title: 'Payout completed',
          detail: `₦${(updated.amount / 100).toLocaleString('en-NG')} was sent to ${updated.accountMasked}.`,
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

/** Poll Bachs for payouts that have sat in `processing` too long (reconciliation job). */
export async function reconcileStalePayouts(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_PAYOUT_AFTER_MS);
  const stale = await db.payout.findMany({
    where: { status: 'processing', requestedAt: { lte: staleThreshold } },
    take: 50,
  });

  for (const payout of stale) {
    const space = await db.space.findUnique({ where: { id: payout.spaceId }, select: { bachsAccountId: true } });
    if (!space?.bachsAccountId) continue;

    try {
      const status = await getWithdrawal(space.bachsAccountId, payout.reference);
      if (!status) continue;
      if (status.status === 'COMPLETED') await settlePayout(payout.reference, true);
      else if (status.status === 'FAILED' || status.status === 'REJECTED') await settlePayout(payout.reference, false);
    } catch (err) {
      console.error(`[payout] reconciliation failed for ${payout.reference}:`, err);
    }
  }
}

/**
 * The split — transfers each cleared DuePayment's face amount into its
 * department's Bachs connected-account balance, replacing the old at-charge
 * subaccount split. Fires once the same 24h clearing window today's payout
 * balance used to gate on has passed; on INSUFFICIENT_BALANCE (settlement
 * lag) it's simply left for the next sweep tick.
 */
export async function sweepSettledDuePayments(): Promise<void> {
  const clearedThreshold = new Date(Date.now() - CLEARING_WINDOW_MS);
  const pending = await db.duePayment.findMany({
    where: { paidAt: { lte: clearedThreshold }, transferredAt: null },
    include: { due: { include: { space: { select: { bachsAccountId: true } } } } },
    take: 50,
  });

  for (const payment of pending) {
    const accountId = payment.due.space.bachsAccountId;
    if (!accountId) continue; // department hasn't onboarded yet — leave for the next tick

    try {
      const transfer = await createTransfer(
        {
          destinationAccountId: accountId,
          amountKobo: payment.netToSpace,
          transferGroup: payment.reference,
          description: `Payment for "${payment.due.title}"`,
        },
        `SPLIT-${payment.reference}`,
      );
      await db.duePayment.update({
        where: { id: payment.id },
        data: { transferredAt: new Date(), splitTransferId: transfer.id },
      });
    } catch (err) {
      if (err instanceof BachsApiError && err.code === 'INSUFFICIENT_BALANCE') continue;
      console.error(`[payout] split-transfer failed for ${payment.reference}:`, err);
    }
  }
}

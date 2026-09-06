import { type Due, type User } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import { computeCharge, generateReference, TIER2_SINGLE_DEPOSIT_LIMIT_KOBO } from '../lib/money';
import { createVirtualNuban, listAccountTransactions } from '../lib/anchor';
import { requireCollectableAccount } from './anchorCustomer.service';
import { notifyMany } from '../lib/notifications';
import { sendDuePaymentReceiptEmail } from '../lib/email';
import { applyPollVotes, type VoteSelection } from './poll.service';
import { maybeAwardReferral } from './referral.service';

/** After a space records a payment, pay any pending referral bounty for its lead rep. */
async function triggerReferralReward(spaceId: string): Promise<void> {
  const lead = await db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, select: { userId: true } });
  if (lead) await maybeAwardReferral(lead.userId).catch(() => {});
}

/** Generate a transaction reference that isn't already taken. */
export async function uniqueReference(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = generateReference();
    const clash = await db.transaction.findUnique({ where: { reference: ref } });
    if (!clash) return ref;
  }
  // Astronomically unlikely; fall back to a timestamped ref.
  return `DVY-${Date.now()}`;
}

/** A single payment would breach Anchor's TIER_2 per-deposit ceiling (PRD §3.4). */
export class TierLimitExceededError extends Error {
  limitKobo = TIER2_SINGLE_DEPOSIT_LIMIT_KOBO;
  constructor(public attemptedKobo: number) {
    super('This payment exceeds the maximum single transfer allowed on this account');
    this.name = 'TierLimitExceededError';
  }
}

// ---------------------------------------------------------------------------
// Online — bank transfer to a single-use virtual account.
//
// Anchor is a BaaS, not a gateway: there is no hosted checkout page. Each
// checkout gets its own dynamic virtual NUBAN, fixed to this payment's
// reference and expiring after ANCHOR_VA_EXPIRY_SECONDS, settling into the
// space's own deposit account. The payer transfers from any bank app and the
// screen polls; nothing is ever marked paid by the client (PRD §5.2).
//
// Because the space's account receives the full charge, the money does NOT need
// moving to the department afterwards — what moves is Duevy's 2%, swept out by
// sweepServiceCharges(). That is the reverse of the old Bachs split.
// ---------------------------------------------------------------------------

export interface BankTransferInstructions {
  accountNumber: string;
  bankName: string;
  accountName: string;
  amountKobo: number;
  expiresAt: string;
}

export interface InvoiceResult {
  reference: string;
  amount: number; // kobo, totalCharged
  /** Always null — Anchor has no hosted checkout. Kept so the response shape stays stable. */
  checkoutUrl: null;
  bankTransfer: BankTransferInstructions;
}

export interface RedeemedDiscount {
  id: string;
  amountKobo: number;
}

interface CheckoutAccount extends BankTransferInstructions {
  virtualNubanId: string;
}

/** Creates the checkout's virtual account against the space's deposit account. */
async function openCheckoutAccount(
  spaceId: string,
  reference: string,
  amountKobo: number,
  metadata: Record<string, string>,
): Promise<CheckoutAccount> {
  if (amountKobo > TIER2_SINGLE_DEPOSIT_LIMIT_KOBO) throw new TierLimitExceededError(amountKobo);

  const { accountId, customerId } = await requireCollectableAccount(spaceId);
  const nuban = await createVirtualNuban({
    settlementAccountId: accountId,
    customerId,
    reference,
    expirySeconds: env.ANCHOR_VA_EXPIRY_SECONDS,
    metadata,
  });

  return {
    virtualNubanId: nuban.id,
    accountNumber: nuban.accountNumber,
    bankName: nuban.bankName,
    accountName: nuban.accountName,
    amountKobo,
    expiresAt: nuban.expiresAt.toISOString(),
  };
}

export async function initOnlineDuePayment(
  user: User,
  due: Due & { space: { name: string } },
  discount?: RedeemedDiscount,
): Promise<InvoiceResult> {
  const charge = computeCharge(due.amount, discount?.amountKobo ?? 0);
  if (charge.totalCharged > TIER2_SINGLE_DEPOSIT_LIMIT_KOBO) {
    throw new TierLimitExceededError(charge.totalCharged);
  }
  const reference = await uniqueReference();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: 'Anchor',
        status: 'pending',
        reference,
        spaceId: due.spaceId,
      },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId: user.id,
        type: 'due_payment',
        // discountCodeId is only redeemed once this actually completes
        // (fulfilByReference) — a failed/expired/abandoned charge leaves the
        // code untouched for reuse. discountAmountKobo is snapshotted here (not
        // re-looked-up) so fulfilment recomputes the exact same totalCharged
        // that was actually invoiced.
        metadata: {
          dueId: due.id,
          amount: charge.totalCharged,
          discountCodeId: discount?.id ?? null,
          discountAmountKobo: discount?.amountKobo ?? 0,
        },
        // The pending row outlives the virtual account so an expired checkout
        // still resolves to a clear "expired" rather than a 404.
        expiresAt: new Date(Date.now() + env.ANCHOR_VA_EXPIRY_SECONDS * 1000),
      },
    });
  });

  const account = await openCheckoutAccount(due.spaceId, reference, charge.totalCharged, {
    dueId: due.id,
    userId: user.id,
  });

  // Persist so GET /payments/:reference/status (and a reload of the dedicated
  // payment page) can re-render the same account without needing this closure.
  await db.pendingPayment.update({
    where: { reference },
    data: {
      metadata: {
        dueId: due.id,
        amount: charge.totalCharged,
        discountCodeId: discount?.id ?? null,
        discountAmountKobo: discount?.amountKobo ?? 0,
        virtualNubanId: account.virtualNubanId,
        virtualAccountNumber: account.accountNumber,
        virtualAccountBankName: account.bankName,
        virtualAccountName: account.accountName,
        virtualAccountExpiresAt: account.expiresAt,
      },
    },
  });

  return {
    reference,
    amount: charge.totalCharged,
    checkoutUrl: null,
    bankTransfer: {
      accountNumber: account.accountNumber,
      bankName: account.bankName,
      accountName: account.accountName,
      amountKobo: account.amountKobo,
      expiresAt: account.expiresAt,
    },
  };
}

/**
 * Same virtual-account checkout as `initOnlineDuePayment`, for a paid poll vote.
 * Extracted out of routes/polls.ts so both payment surfaces share one
 * implementation.
 */
export async function initOnlinePollVote(
  user: User,
  poll: { id: string; title: string; spaceId: string; amountPerVote: number },
  selections: VoteSelection[],
  totalCharged: number,
): Promise<InvoiceResult> {
  if (totalCharged > TIER2_SINGLE_DEPOSIT_LIMIT_KOBO) throw new TierLimitExceededError(totalCharged);
  const reference = await uniqueReference();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'vote',
        title: `Votes: ${poll.title}`,
        detail: 'Poll',
        amount: -totalCharged,
        method: 'Anchor',
        status: 'pending',
        reference,
        spaceId: poll.spaceId,
      },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId: user.id,
        type: 'poll_vote',
        metadata: { pollId: poll.id, amountPerVote: poll.amountPerVote, selections },
        expiresAt: new Date(Date.now() + env.ANCHOR_VA_EXPIRY_SECONDS * 1000),
      },
    });
  });

  const account = await openCheckoutAccount(poll.spaceId, reference, totalCharged, {
    pollId: poll.id,
    userId: user.id,
  });

  await db.pendingPayment.update({
    where: { reference },
    data: {
      metadata: {
        pollId: poll.id,
        amountPerVote: poll.amountPerVote,
        selections,
        amount: totalCharged,
        virtualNubanId: account.virtualNubanId,
        virtualAccountNumber: account.accountNumber,
        virtualAccountBankName: account.bankName,
        virtualAccountName: account.accountName,
        virtualAccountExpiresAt: account.expiresAt,
      },
    },
  });

  return {
    reference,
    amount: totalCharged,
    checkoutUrl: null,
    bankTransfer: {
      accountNumber: account.accountNumber,
      bankName: account.bankName,
      accountName: account.accountName,
      amountKobo: account.amountKobo,
      expiresAt: account.expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Fulfilment — invoked by the payment.received webhook, the status poller, and
// the reconciliation job. The one idempotent entry point all three share.
// ---------------------------------------------------------------------------

export type FulfilOutcome = 'fulfilled' | 'already' | 'failed' | 'unknown' | 'underpaid';

export interface FulfilOptions {
  /**
   * What Anchor actually credited, when known. A virtual NUBAN carries no
   * amount, so it cannot enforce what the payer sends — the check has to happen
   * here (PRD §9.1). Omit when the caller has no figure (a status poll), in
   * which case the recorded total is trusted.
   */
  creditedKobo?: number;
}

/** Raises an unmatched/mismatched payment to the platform admins for manual resolution. */
async function flagToAdmins(title: string, detail: string): Promise<void> {
  const admins = await db.user.findMany({ where: { role: 'admin' }, select: { id: true } });
  await notifyMany(
    admins.map((a) => a.id),
    { kind: 'system', tone: 'rose', title, detail, href: '/admin/transactions' },
  ).catch(() => {});
}

export async function fulfilByReference(
  reference: string,
  success: boolean,
  opts: FulfilOptions = {},
): Promise<FulfilOutcome> {
  const pending = await db.pendingPayment.findUnique({ where: { reference } });
  if (!pending) return 'unknown';
  if (pending.status === 'completed') return 'already';
  if (pending.status === 'failed') return 'already';

  if (!success) {
    await db.$transaction([
      db.pendingPayment.update({ where: { reference }, data: { status: 'failed' } }),
      db.transaction.updateMany({ where: { reference }, data: { status: 'failed' } }),
    ]);
    return 'failed';
  }

  const meta = (pending.metadata ?? {}) as {
    amount?: number;
    dueId?: string;
    discountCodeId?: string | null;
    discountAmountKobo?: number;
    virtualNubanId?: string;
    virtualAccountNumber?: string;
    virtualAccountExpiresAt?: string;
    underpaidFlaggedAt?: string;
  } & Record<string, unknown>;

  // Underpayment leaves everything pending and goes to a human: no due is
  // marked paid on a short transfer, and the payer sees "we received ₦X of ₦Y".
  //
  // The row stays `pending`, so reconciliation re-checks it every tick — the
  // flag is therefore recorded on the payment and raised to admins exactly
  // once, rather than notifying them every five minutes until someone acts.
  const expected = meta.amount ?? 0;
  if (opts.creditedKobo !== undefined && expected > 0 && opts.creditedKobo < expected) {
    if (!meta.underpaidFlaggedAt) {
      await db.pendingPayment.update({
        where: { reference },
        data: {
          metadata: {
            ...meta,
            underpaidFlaggedAt: new Date().toISOString(),
            underpaidCreditedKobo: opts.creditedKobo,
          },
        },
      });
      await flagToAdmins(
        'Underpaid transfer',
        `${reference}: received ₦${(opts.creditedKobo / 100).toLocaleString('en-NG')} of ₦${(expected / 100).toLocaleString('en-NG')}.`,
      );
    }
    return 'underpaid';
  }
  // Overpayment is honoured, and the excess is flagged for a manual refund.
  if (opts.creditedKobo !== undefined && expected > 0 && opts.creditedKobo > expected) {
    await flagToAdmins(
      'Overpaid transfer',
      `${reference}: received ₦${(opts.creditedKobo / 100).toLocaleString('en-NG')} against ₦${(expected / 100).toLocaleString('en-NG')} — ₦${((opts.creditedKobo - expected) / 100).toLocaleString('en-NG')} to refund.`,
    );
  }

  if (pending.type === 'due_payment' && meta.dueId) {
    const due = await db.due.findUnique({ where: { id: meta.dueId }, include: { space: { select: { name: true } } } });
    if (!due) return 'unknown';

    // Guard against a duplicate DuePayment (webhook + reconciliation racing).
    const existing = await db.duePayment.findUnique({
      where: { userId_dueId: { userId: pending.userId, dueId: due.id } },
    });

    const charge = computeCharge(due.amount, meta.discountAmountKobo ?? 0);
    const txn = await db.transaction.findUnique({ where: { reference } });

    await db.$transaction(async (tx) => {
      await tx.pendingPayment.update({ where: { reference }, data: { status: 'completed' } });
      await tx.transaction.updateMany({ where: { reference }, data: { status: 'completed' } });
      if (!existing) {
        const duePayment = await tx.duePayment.create({
          data: {
            userId: pending.userId,
            dueId: due.id,
            txnId: txn?.id,
            reference,
            amountPaid: charge.totalCharged,
            processingFee: charge.processingFee,
            duevyFee: charge.duevyFee,
            netToSpace: charge.netToSpace,
            virtualNubanId: meta.virtualNubanId ?? null,
            virtualAccountNumber: meta.virtualAccountNumber ?? null,
            virtualAccountExpiresAt: meta.virtualAccountExpiresAt
              ? new Date(meta.virtualAccountExpiresAt)
              : null,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            spaceId: due.spaceId,
            dueId: due.id,
            txnId: txn?.id,
            duePaymentId: duePayment.id,
            type: 'due_payment',
            direction: 'credit',
            amountKobo: charge.netToSpace,
            grossKobo: charge.totalCharged,
            feeKobo: charge.totalFee,
            netKobo: charge.netToSpace,
            reference,
            description: `Payment for "${due.title}"`,
          },
        });
        if (meta.discountCodeId) {
          await tx.discountCode.update({ where: { id: meta.discountCodeId }, data: { redeemedAt: new Date(), dueId: due.id } });
        }
      }
    });

    const payer = await db.user.findUnique({ where: { id: pending.userId }, select: { name: true, email: true } });
    await notifyRepsOfPayment(due.spaceId, payer?.name ?? 'A member', due.title, due.amount).catch(() => {});
    if (payer) {
      await sendDuePaymentReceiptEmail(payer.email, payer.name, {
        dueTitle: due.title,
        spaceName: due.space.name,
        amountPaidKobo: charge.totalCharged,
        reference,
        dueId: due.id,
      }).catch(() => {});
    }
    await triggerReferralReward(due.spaceId);
    return 'fulfilled';
  }

  if (pending.type === 'poll_vote') {
    const voteMeta = (pending.metadata ?? {}) as {
      pollId?: string;
      amountPerVote?: number;
      selections?: VoteSelection[];
    };
    if (!voteMeta.pollId || !voteMeta.selections) return 'unknown';

    await db.$transaction(async (tx) => {
      await tx.pendingPayment.update({ where: { reference }, data: { status: 'completed' } });
      await tx.transaction.updateMany({ where: { reference }, data: { status: 'completed' } });
      await applyPollVotes(tx, {
        pollId: voteMeta.pollId as string,
        userId: pending.userId,
        selections: voteMeta.selections as VoteSelection[],
        amountPerVote: voteMeta.amountPerVote ?? 0,
        reference,
      });
    });
    return 'fulfilled';
  }

  return 'unknown';
}

/**
 * payment.settled — the inflow has cleared from the virtual account into the
 * space's deposit account, so the money is genuinely spendable. This is what
 * computeBalances() gates `available` on; payment.received only proves the
 * payer sent it.
 */
export async function markPaymentSettled(reference: string): Promise<void> {
  await db.duePayment.updateMany({
    where: { reference, settledAt: null },
    data: { settledAt: new Date() },
  });
}

/** Which Anchor account a checkout was settling into, from its pending metadata. */
export async function settlementAccountFor(metadata: unknown): Promise<string | null> {
  const meta = (metadata ?? {}) as { dueId?: string; pollId?: string };

  if (meta.dueId) {
    const due = await db.due.findUnique({
      where: { id: meta.dueId },
      select: { space: { select: { anchorAccountId: true } } },
    });
    return due?.space.anchorAccountId ?? null;
  }
  if (meta.pollId) {
    const poll = await db.poll.findUnique({
      where: { id: meta.pollId },
      select: { space: { select: { anchorAccountId: true } } },
    });
    return poll?.space.anchorAccountId ?? null;
  }
  return null;
}

/**
 * Active check for one pending payment, behind the payer's "I've made payment"
 * tap. Anchor has no checkout session to query, so the check is whether a
 * credit carrying our reference has landed in the settlement account.
 *
 * The webhook remains the source of truth; fulfilByReference is idempotent, so
 * this racing with it is safe by construction.
 */
export async function pollInflow(reference: string): Promise<FulfilOutcome | 'pending'> {
  const pending = await db.pendingPayment.findUnique({ where: { reference } });
  if (!pending || pending.status !== 'pending') return 'already';

  const accountId = await settlementAccountFor(pending.metadata);
  if (!accountId) return 'pending';

  const transactions = await listAccountTransactions(accountId, { limit: 100 });
  const credit = transactions.find((t) => t.direction === 'CREDIT' && t.reference === reference);
  if (credit) return fulfilByReference(reference, true, { creditedKobo: credit.amountKobo });

  // Nothing arrived and the account is closed — this checkout is over. The row
  // is only marked failed here, never paid, so an expired-then-paid transfer
  // still gets picked up by reconciliation as an unmatched inflow.
  if (pending.expiresAt <= new Date()) return fulfilByReference(reference, false);
  return 'pending';
}

// ---------------------------------------------------------------------------
async function notifyRepsOfPayment(spaceId: string, payerName: string, dueTitle: string, amount: number): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    {
      kind: 'payment_received',
      title: 'Payment received',
      detail: `${payerName} paid ₦${(amount / 100).toLocaleString('en-NG')} for "${dueTitle}".`,
      href: '/dashboard/collections',
    },
  );
}

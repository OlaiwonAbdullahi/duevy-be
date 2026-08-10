import { type Due, type Transaction, type User } from '@prisma/client';
import { db } from '../config/db';
import { computeCharge, generateReference } from '../lib/money';
import { createCheckoutSession } from '../lib/bachs';
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

// ---------------------------------------------------------------------------
// Online — in-app checkout (§6.3 method=online). Duevy always collects the
// full charge on its own Bachs account; the department's share moves later,
// via the split-transfer sweep once the payment clears (see
// sweepSettledDuePayments() in payout.service.ts) — not at checkout time.
// ---------------------------------------------------------------------------
export interface InvoiceResult {
  reference: string;
  amount: number; // kobo, totalCharged
  checkoutUrl: string;
  /** Not exposed by Bachs checkout sessions — kept for frontend compatibility with the old Monnify-invoice shape. */
  bankTransfer: null;
}

const INVOICE_EXPIRY_MS = 60 * 60 * 1000; // 1h

export interface RedeemedDiscount {
  id: string;
  amountKobo: number;
}

export async function initOnlineDuePayment(
  user: User,
  due: Due & { space: { name: string } },
  discount?: RedeemedDiscount,
): Promise<InvoiceResult> {
  const charge = computeCharge(due.amount, discount?.amountKobo ?? 0);
  const reference = await uniqueReference();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: 'Bachs',
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
        // discountCodeId is only redeemed once this actually completes (fulfilByReference)
        // — a failed/expired/abandoned charge leaves the code untouched for reuse.
        // discountAmountKobo is snapshotted here (not re-looked-up) so fulfilment
        // recomputes the exact same totalCharged that was actually invoiced.
        metadata: {
          dueId: due.id,
          amount: charge.totalCharged,
          discountCodeId: discount?.id ?? null,
          discountAmountKobo: discount?.amountKobo ?? 0,
        },
        expiresAt: new Date(Date.now() + INVOICE_EXPIRY_MS),
      },
    });
  });

  const charged = await createCheckoutSession({
    amountKobo: charge.totalCharged,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: due.title,
    callbackPath: `/dashboard/pay/${reference}?dueId=${due.id}`,
  });

  // Persist so GET /payments/:reference/status (and a reload of the dedicated
  // payment page) can render the same checkout without needing this closure.
  await db.pendingPayment.update({
    where: { reference },
    data: {
      metadata: {
        dueId: due.id,
        amount: charge.totalCharged,
        discountCodeId: discount?.id ?? null,
        discountAmountKobo: discount?.amountKobo ?? 0,
        checkoutUrl: charged.checkoutUrl,
      },
    },
  });

  return { reference, amount: charge.totalCharged, checkoutUrl: charged.checkoutUrl, bankTransfer: null };
}

/**
 * Same in-app checkout flow as `initOnlineDuePayment`, for a paid poll vote.
 * Extracted out of routes/polls.ts so both payment surfaces share one
 * checkout-session implementation.
 */
export async function initOnlinePollVote(
  user: User,
  poll: { id: string; title: string; spaceId: string; amountPerVote: number },
  selections: VoteSelection[],
  totalCharged: number,
): Promise<InvoiceResult> {
  const reference = await uniqueReference();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'vote',
        title: `Votes: ${poll.title}`,
        detail: 'Poll',
        amount: -totalCharged,
        method: 'Bachs',
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
        expiresAt: new Date(Date.now() + INVOICE_EXPIRY_MS),
      },
    });
  });

  const charged = await createCheckoutSession({
    amountKobo: totalCharged,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: `Votes: ${poll.title}`,
    callbackPath: `/dashboard/pay/${reference}`,
  });

  await db.pendingPayment.update({
    where: { reference },
    data: {
      metadata: {
        pollId: poll.id,
        amountPerVote: poll.amountPerVote,
        selections,
        amount: totalCharged,
        checkoutUrl: charged.checkoutUrl,
      },
    },
  });

  return { reference, amount: totalCharged, checkoutUrl: charged.checkoutUrl, bankTransfer: null };
}

// ---------------------------------------------------------------------------
// Fulfilment — invoked by the webhook (§15) and the status poller (§6.4)
// ---------------------------------------------------------------------------
export type FulfilOutcome = 'fulfilled' | 'already' | 'failed' | 'unknown';

export async function fulfilByReference(reference: string, success: boolean): Promise<FulfilOutcome> {
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
  };

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

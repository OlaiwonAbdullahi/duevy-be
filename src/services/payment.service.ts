import { type Due, type Transaction, type User } from '@prisma/client';
import { db } from '../config/db';
import { computeCharge, generateReference } from '../lib/money';
import { initTransaction, chargeCardToken } from '../lib/monnify';
import { notify, notifyMany } from '../lib/notifications';
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
// Wallet — synchronous due settlement (§6.3, method=wallet)
// ---------------------------------------------------------------------------
export async function settleDueFromWallet(user: User, due: Due & { space: { name: string } }): Promise<Transaction> {
  const charge = computeCharge(due.amount);
  const reference = await uniqueReference();

  const txn = await db.$transaction(async (tx) => {
    // Debit the payer the full charge (face + fee), only if covered (guards races).
    const updated = await tx.user.updateMany({
      where: { id: user.id, walletBalance: { gte: charge.totalCharged } },
      data: { walletBalance: { decrement: charge.totalCharged } },
    });
    if (updated.count === 0) {
      throw new InsufficientFundsError();
    }

    const transaction = await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: 'Wallet',
        status: 'completed',
        reference,
        spaceId: due.spaceId,
      },
    });

    await tx.duePayment.create({
      data: {
        userId: user.id,
        dueId: due.id,
        txnId: transaction.id,
        reference,
        amountPaid: charge.totalCharged,
        monnifyFee: charge.monnifyFee,
        duevyFee: charge.duevyFee,
        netToSpace: charge.netToSpace,
      },
    });

    return transaction;
  });

  await notifyRepsOfPayment(due.spaceId, user.name, due.title, due.amount).catch(() => {});
  await triggerReferralReward(due.spaceId);
  return txn;
}

// ---------------------------------------------------------------------------
// Card — synchronous charge of a saved, tokenized card (§6.3/§8.2/§11.6, method=card)
// ---------------------------------------------------------------------------
export interface CardChargeResult {
  reference: string;
  methodLabel: string;
}

/** Charge a saved card for `amount` kobo. Looks up the card, hits Monnify, and
 * returns a reference the caller can use to write its own ledger rows. */
export async function chargeSavedCard(
  userId: string,
  cardId: string,
  amount: number,
  description: string,
): Promise<CardChargeResult> {
  const [card, user] = await Promise.all([
    db.card.findFirst({ where: { id: cardId, userId } }),
    db.user.findUnique({ where: { id: userId } }),
  ]);
  if (!card || !user) throw new CardNotFoundError();

  const reference = await uniqueReference();
  const result = await chargeCardToken({
    amount,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description,
    cardToken: card.providerToken,
  });
  if (!result.paid) throw new CardChargeFailedError();

  return { reference, methodLabel: `${card.brand} •••• ${card.last4}` };
}

export async function settleDueFromCard(
  user: User,
  due: Due & { space: { name: string } },
  cardId: string,
): Promise<Transaction> {
  const charge = computeCharge(due.amount);
  const { reference, methodLabel } = await chargeSavedCard(user.id, cardId, charge.totalCharged, due.title);

  const txn = await db.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: methodLabel,
        status: 'completed',
        reference,
        spaceId: due.spaceId,
      },
    });

    await tx.duePayment.create({
      data: {
        userId: user.id,
        dueId: due.id,
        txnId: transaction.id,
        reference,
        amountPaid: charge.totalCharged,
        monnifyFee: charge.monnifyFee,
        duevyFee: charge.duevyFee,
        netToSpace: charge.netToSpace,
      },
    });

    return transaction;
  });

  await notifyRepsOfPayment(due.spaceId, user.name, due.title, due.amount).catch(() => {});
  await triggerReferralReward(due.spaceId);
  return txn;
}

export async function chargeCardForTopUp(user: User, amount: number, cardId: string): Promise<Transaction> {
  const { reference, methodLabel } = await chargeSavedCard(user.id, cardId, amount, 'Wallet top-up');

  return db.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'topup',
        title: 'Wallet top-up',
        detail: methodLabel,
        amount,
        method: methodLabel,
        status: 'completed',
        reference,
      },
    });
    await tx.user.update({ where: { id: user.id }, data: { walletBalance: { increment: amount } } });
    return transaction;
  });
}

// ---------------------------------------------------------------------------
// Online — hosted checkout (§6.3 method=online, §8.2 method=online)
// ---------------------------------------------------------------------------
export interface CheckoutResult {
  checkoutUrl: string;
  reference: string;
}

export async function initOnlineTopUp(user: User, amount: number): Promise<CheckoutResult> {
  const reference = await uniqueReference();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'topup',
        title: 'Wallet top-up',
        detail: 'Monnify',
        amount,
        method: 'Monnify',
        status: 'pending',
        reference,
      },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId: user.id,
        type: 'topup',
        metadata: { amount },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  const init = await initTransaction({
    amount,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: 'Wallet top-up',
  });

  return { checkoutUrl: init.checkoutUrl, reference };
}

export async function initOnlineDuePayment(user: User, due: Due & { space: { name: string } }): Promise<CheckoutResult> {
  const charge = computeCharge(due.amount);
  const reference = await uniqueReference();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: 'Monnify',
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
        metadata: { dueId: due.id, amount: charge.totalCharged },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  // The payer is charged the full amount (face + fee) at checkout.
  const init = await initTransaction({
    amount: charge.totalCharged,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: due.title,
  });

  return { checkoutUrl: init.checkoutUrl, reference };
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

  const meta = (pending.metadata ?? {}) as { amount?: number; dueId?: string };

  if (pending.type === 'topup') {
    await db.$transaction([
      db.pendingPayment.update({ where: { reference }, data: { status: 'completed' } }),
      db.transaction.updateMany({ where: { reference }, data: { status: 'completed' } }),
      db.user.update({ where: { id: pending.userId }, data: { walletBalance: { increment: meta.amount ?? 0 } } }),
    ]);
    await notify({
      userId: pending.userId,
      kind: 'payment_received',
      title: 'Wallet funded',
      detail: `₦${((meta.amount ?? 0) / 100).toLocaleString('en-NG')} was added to your wallet.`,
      href: '/dashboard/wallet',
    }).catch(() => {});
    return 'fulfilled';
  }

  if (pending.type === 'due_payment' && meta.dueId) {
    const due = await db.due.findUnique({ where: { id: meta.dueId }, include: { space: { select: { name: true } } } });
    if (!due) return 'unknown';

    // Guard against a duplicate DuePayment (webhook + reconciliation racing).
    const existing = await db.duePayment.findUnique({
      where: { userId_dueId: { userId: pending.userId, dueId: due.id } },
    });

    const charge = computeCharge(due.amount);
    const txn = await db.transaction.findUnique({ where: { reference } });

    await db.$transaction(async (tx) => {
      await tx.pendingPayment.update({ where: { reference }, data: { status: 'completed' } });
      await tx.transaction.updateMany({ where: { reference }, data: { status: 'completed' } });
      if (!existing) {
        await tx.duePayment.create({
          data: {
            userId: pending.userId,
            dueId: due.id,
            txnId: txn?.id,
            reference,
            amountPaid: charge.totalCharged,
            monnifyFee: charge.monnifyFee,
            duevyFee: charge.duevyFee,
            netToSpace: charge.netToSpace,
          },
        });
      }
    });

    const payer = await db.user.findUnique({ where: { id: pending.userId }, select: { name: true } });
    await notifyRepsOfPayment(due.spaceId, payer?.name ?? 'A member', due.title, due.amount).catch(() => {});
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

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient wallet balance');
    this.name = 'InsufficientFundsError';
  }
}

export class CardNotFoundError extends Error {
  constructor() {
    super('Card not found');
    this.name = 'CardNotFoundError';
  }
}

export class CardChargeFailedError extends Error {
  constructor() {
    super('Card charge was declined');
    this.name = 'CardChargeFailedError';
  }
}

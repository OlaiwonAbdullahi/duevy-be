import { Prisma, type Refund } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { generateReference } from '../lib/money';
import { transferNarration } from '../lib/narration';
import { maskAccountNumber } from '../lib/encryption';
import { generateId } from '../lib/id';
import { notifyMany } from '../lib/notifications';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { appendLedgerEntry, getSpaceBalance, lockSpace } from './ledger.service';
import { checkPin } from './withdrawal.service';

/**
 * Refunds — a lead rep sends a student's money back to the account they paid
 * from. Duevy fronts the transfer from its business account and debits the
 * space's ledger by the refund amount (`refund`); a failed transfer restores
 * the balance (`refund_reversal`). Only a payment with a recorded source
 * account (Checkout.sender*, captured at payment time) can be refunded, and
 * partial refunds are allowed up to what the student paid, minus earlier ones.
 *
 * The money path mirrors withdrawals (services/withdrawal.service.ts): the
 * provider transfer is async, its outcome applied by the webhook
 * (refreshRefund) and, as a backstop, by polling. Every outcome is idempotent.
 */

type Tx = Prisma.TransactionClient;

/** States a refund can move between. */
const REFUND_TRANSITIONS: Record<Refund['status'], Refund['status'][]> = {
  pending: ['processing', 'success', 'failed'],
  processing: ['success', 'failed'],
  success: ['reversed'],
  failed: [],
  reversed: [],
};
const canTransition = (from: Refund['status'], to: Refund['status']) => REFUND_TRANSITIONS[from].includes(to);

export interface RefundRequest {
  spaceId: string;
  dueId: string;
  duePaymentId: string;
  /** The lead rep issuing the refund. */
  requestedById: string;
  amountKobo: number;
  pin: string;
  reason?: string;
}

/** What's still refundable on a payment: what was paid, minus refunds already issued or in flight. */
export async function refundableKobo(duePaymentId: string, tx: Tx | typeof db = db): Promise<number> {
  const [payment, prior] = await Promise.all([
    tx.duePayment.findUnique({ where: { id: duePaymentId }, select: { amountPaid: true } }),
    tx.refund.aggregate({
      where: { duePaymentId, status: { in: ['pending', 'processing', 'success'] } },
      _sum: { amountKobo: true },
    }),
  ]);
  if (!payment) return 0;
  return Math.max(0, payment.amountPaid - (prior._sum.amountKobo ?? 0));
}

export async function requestRefund(req: RefundRequest): Promise<Refund> {
  if (!Number.isInteger(req.amountKobo) || req.amountKobo <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter a refund amount', [{ field: 'amountKobo', issue: 'must be a positive amount' }]);
  }

  const payment = await db.duePayment.findUnique({
    where: { id: req.duePaymentId },
    include: {
      user: { select: { id: true, name: true } },
      checkout: { select: { id: true, senderAccountNumber: true, senderBankCode: true, senderBank: true, senderName: true } },
      due: { select: { id: true, spaceId: true, title: true } },
    },
  });
  if (!payment || payment.dueId !== req.dueId || payment.due.spaceId !== req.spaceId) {
    throw notFound('Payment not found');
  }

  const checkout = payment.checkout;
  if (!checkout?.senderAccountNumber || !checkout.senderBankCode) {
    throw conflict('NO_SOURCE_ACCOUNT', "This payment has no saved source account, so it can't be refunded automatically.");
  }

  const space = await db.space.findUniqueOrThrow({ where: { id: req.spaceId } });
  if (space.withdrawalAuthMode === 'multisig') {
    throw conflict('REFUND_NEEDS_PIN', 'Refunds need a withdrawal security code. Switch the space to code-based withdrawals to use them.');
  }
  // The same security code that guards withdrawals.
  await checkPin(space, req.pin);

  const reference = generateReference('RFD');
  const accountMasked = `${checkout.senderBank ?? 'Bank'} ${maskAccountNumber(checkout.senderAccountNumber)}`;

  const refund = await db.$transaction(async (tx) => {
    await lockSpace(tx, req.spaceId);

    // Re-check inside the lock so two refunds can't together exceed the payment.
    const remaining = await refundableKobo(req.duePaymentId, tx);
    if (remaining <= 0) throw conflict('ALREADY_REFUNDED', 'This payment has already been fully refunded.');
    if (req.amountKobo > remaining) {
      throw new AppError(422, 'REFUND_TOO_LARGE', `You can refund at most ₦${(remaining / 100).toLocaleString('en-NG')} of this payment.`, [
        { field: 'amountKobo', issue: `at most ${remaining} kobo` },
      ]);
    }
    const balance = await getSpaceBalance(req.spaceId, tx);
    if (req.amountKobo > balance) {
      throw conflict('INSUFFICIENT_BALANCE', `The space balance (₦${(balance / 100).toLocaleString('en-NG')}) can't cover this refund.`);
    }

    const created = await tx.refund.create({
      data: {
        id: generateId('refund'),
        reference,
        spaceId: req.spaceId,
        dueId: req.dueId,
        duePaymentId: req.duePaymentId,
        checkoutId: checkout.id,
        userId: payment.user.id,
        amountKobo: req.amountKobo,
        status: 'pending',
        bankCode: checkout.senderBankCode!,
        bankName: checkout.senderBank,
        accountNumber: checkout.senderAccountNumber!,
        accountName: checkout.senderName,
        accountMasked,
        reason: req.reason?.slice(0, 300) ?? null,
        requestedById: req.requestedById,
        provider: getPaymentProvider().name,
      },
    });

    // Debit the space now, like a withdrawal: the balance always reflects what
    // can still be moved. Restored in full if the transfer fails.
    await appendLedgerEntry(tx, {
      spaceId: req.spaceId,
      dueId: req.dueId,
      refundId: created.id,
      type: 'refund',
      direction: 'debit',
      amountKobo: req.amountKobo,
      reference,
      description: `Refund to ${payment.user.name} (${accountMasked})`,
      actorId: req.requestedById,
    });

    // The payer's own history shows the money coming back.
    await tx.transaction.create({
      data: {
        id: generateId('transaction'),
        userId: payment.user.id,
        type: 'refund',
        title: `Refund — ${payment.due.title}`,
        detail: space.name,
        amount: req.amountKobo,
        method: 'Bank transfer',
        status: 'pending',
        reference,
        spaceId: req.spaceId,
        refundOfTxnId: payment.txnId,
      },
    });

    return created;
  });

  logger.info({ ref: reference, spaceId: req.spaceId, amount: req.amountKobo }, 'refund created');
  await dispatchRefund(refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

async function lockRefund(tx: Tx, refundId: string): Promise<Refund> {
  await tx.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${refundId} FOR UPDATE`;
  return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
}

/**
 * Send a pending refund from Duevy's business account. Safe to call again (the
 * reconciliation/refresh path does): the provider refuses a second transfer
 * under the same reference, and the state change is guarded.
 */
export async function dispatchRefund(refundId: string): Promise<void> {
  const refund = await db.refund.findUnique({ where: { id: refundId } });
  if (!refund || refund.status !== 'pending') return;

  const space = await db.space.findUniqueOrThrow({ where: { id: refund.spaceId }, select: { short: true } });
  try {
    const result = await getPaymentProvider().initiateTransfer({
      from: 'business',
      bankCode: refund.bankCode,
      accountNumber: refund.accountNumber,
      accountName: refund.accountName ?? '',
      amountKobo: refund.amountKobo,
      reference: refund.reference,
      narration: transferNarration({ spaceCode: space.short, amountKobo: refund.amountKobo }),
    });
    await db.$transaction(async (tx) => {
      const r = await lockRefund(tx, refund.id);
      if (r.status !== 'pending') return;
      await tx.refund.update({
        where: { id: r.id },
        data: { status: 'processing', processingAt: new Date(), providerRefundId: result.providerReference },
      });
    });
    logger.info({ ref: refund.reference, state: result.state }, 'refund dispatched');
    if (result.state === 'succeeded') await completeRefund(refund.reference);
    if (result.state === 'failed') await failRefund(refund.id, result.failureReason ?? 'The bank could not complete the transfer');
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      const reason = err.code === 'ACCOUNT_UNVERIFIABLE' ? 'The bank could not verify the account.' : err.message;
      await failRefund(refund.id, reason, err.code ?? undefined);
      return;
    }
    // Timeout / 5xx: the transfer may exist. Leave it pending; the refresh path
    // resends under the same reference, which the provider refuses as a duplicate.
    logger.warn({ ref: refund.reference, err: (err as Error).message }, 'refund dispatch deferred');
  }
}

/** The transfer succeeded — idempotent. */
export async function completeRefund(reference: string): Promise<boolean> {
  const done = await db.$transaction(async (tx) => {
    const found = await tx.refund.findUnique({ where: { reference }, select: { id: true } });
    if (!found) return null;
    const r = await lockRefund(tx, found.id);
    if (!canTransition(r.status, 'success')) return null;
    await tx.transaction.updateMany({ where: { reference, status: 'pending' }, data: { status: 'completed' } });
    return tx.refund.update({ where: { id: r.id }, data: { status: 'success', settledAt: new Date() } });
  });
  if (!done) return false;
  logger.info({ ref: reference }, 'refund succeeded');
  await notifyRefund(done, 'success');
  return true;
}

export async function failRefundByReference(reference: string, reason: string): Promise<boolean> {
  const r = await db.refund.findUnique({ where: { reference }, select: { id: true } });
  return r ? failRefund(r.id, reason) : false;
}

/** The transfer failed (or a completed one was returned) — idempotent; restores the balance. */
export async function failRefund(refundId: string, reason: string, code?: string): Promise<boolean> {
  const done = await db.$transaction(async (tx) => {
    const r = await lockRefund(tx, refundId);
    const to = r.status === 'success' ? 'reversed' : 'failed';
    if (!canTransition(r.status, to)) return null;

    await lockSpace(tx, r.spaceId);
    const updated = await tx.refund.update({
      where: { id: r.id },
      data: { status: to, failureReason: reason.slice(0, 300), ...(to === 'reversed' ? { reversedAt: new Date() } : { failedAt: new Date() }) },
    });
    // Put the money back on the space's ledger.
    await appendLedgerEntry(tx, {
      spaceId: r.spaceId,
      dueId: r.dueId,
      refundId: r.id,
      type: 'refund_reversal',
      direction: 'credit',
      amountKobo: r.amountKobo,
      reference: r.reference,
      description: to === 'reversed' ? 'Refund returned by the bank' : 'Refund failed — balance restored',
    });
    await tx.transaction.updateMany({ where: { reference: r.reference, status: 'pending' }, data: { status: 'failed' } });
    return updated;
  });
  if (!done) return false;
  logger.warn({ ref: done.reference, status: done.status, reason, code }, 'refund failed — balance restored');
  await notifyRefund(done, 'failed');
  return true;
}

/** Re-read a processing refund's state from the provider (webhook + backstop). */
export async function refreshRefund(refundId: string): Promise<void> {
  const r = await db.refund.findUnique({ where: { id: refundId } });
  if (!r || r.status !== 'processing') return;
  let result;
  try {
    result = await getPaymentProvider().getTransfer(r.reference);
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'NOT_FOUND') {
      const { count } = await db.refund.updateMany({ where: { id: r.id, status: 'processing' }, data: { status: 'pending', processingAt: null } });
      if (count === 1) {
        logger.warn({ ref: r.reference }, 'refund unknown to the provider — sending it again');
        await dispatchRefund(r.id);
      }
      return;
    }
    throw err;
  }
  if (result.state === 'succeeded') await completeRefund(r.reference);
  else if (result.state === 'failed') await failRefund(r.id, result.failureReason ?? 'The bank could not complete the transfer');
}

async function notifyRefund(r: Refund, outcome: 'success' | 'failed'): Promise<void> {
  const naira = (k: number) => `₦${(k / 100).toLocaleString('en-NG')}`;
  // The payer (if they have a dashboard) and the space's reps.
  const reps = await db.spaceRep.findMany({ where: { spaceId: r.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((rep) => rep.userId),
    outcome === 'success'
      ? { kind: 'system', tone: 'brand', title: 'Refund sent', detail: `${naira(r.amountKobo)} was refunded to ${r.accountMasked}.`, href: '/dashboard/create-dues' }
      : { kind: 'system', tone: 'rose', title: 'Refund failed', detail: `The ${naira(r.amountKobo)} refund (${r.reference}) didn't go through and was returned to the space balance.`, href: '/dashboard/create-dues' },
  ).catch(() => {});
  await notifyMany([r.userId], {
    kind: 'system',
    tone: outcome === 'success' ? 'brand' : 'rose',
    title: outcome === 'success' ? 'Refund on its way' : 'Refund could not be sent',
    detail:
      outcome === 'success'
        ? `${naira(r.amountKobo)} is being refunded to your account ${r.accountMasked}.`
        : `We couldn't send your ${naira(r.amountKobo)} refund. Please contact your rep.`,
    href: `${env.FRONTEND_URL}`,
  }).catch(() => {});
}

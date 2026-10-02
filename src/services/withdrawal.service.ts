import { Prisma, type Payout } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { computeWithdrawal, generatePayoutReference, MIN_PAYOUT_KOBO } from '../lib/money';
import { assertPayoutTransition, canTransitionPayout } from '../lib/stateMachine';
import { notifyMany } from '../lib/notifications';
import { writeAudit } from '../lib/audit';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { appendLedgerEntry, getSpaceBalance, lockSpace } from './ledger.service';
import { canWithdraw } from './kyc.service';

/**
 * Withdrawals: a space's lead rep moves the space's balance to their own
 * verified bank account.
 *
 *   gross = what the rep asks for, debited from the space's ledger
 *   fee   = ₦100 (< ₦50,000) or ₦200 (≥ ₦50,000), deducted from the gross
 *   net   = gross − fee, sent to the bank
 *
 * Safety, in order:
 *  1. Idempotency-Key on the route (a retried request replays).
 *  2. A transaction-scoped advisory lock per space: the balance check and the
 *     ledger debit happen atomically, so two requests can't both spend it.
 *  3. Payout.activeSpaceId is unique: a second in-flight withdrawal for the
 *     same space is impossible even if the lock were bypassed.
 *  4. The ledger is debited when the withdrawal is CREATED. A failure or
 *     reversal credits the full gross back (payout_reversal).
 *  5. The provider call uses our reference as its idempotency key.
 *
 * Status: pending → processing → success | failed | reversed.
 */

type Tx = Prisma.TransactionClient;

export class WithdrawalInProgressError extends AppError {
  constructor(reference?: string) {
    super(409, 'WITHDRAWAL_IN_PROGRESS', `Another withdrawal for this space is still in progress${reference ? ` (${reference})` : ''}`);
  }
}

export interface WithdrawalRequest {
  spaceId: string;
  userId: string;
  amountKobo: number;
  note?: string;
}

export async function quoteWithdrawal(amountKobo: number) {
  const b = computeWithdrawal(amountKobo);
  return { amount: b.gross, fee: b.fee, net: b.net, minPayout: MIN_PAYOUT_KOBO, belowMinimum: amountKobo < MIN_PAYOUT_KOBO };
}

async function uniquePayoutReference(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = generatePayoutReference();
    if (!(await db.payout.findUnique({ where: { reference: ref }, select: { id: true } }))) return ref;
  }
  throw new Error('could not allocate a unique payout reference');
}

export async function requestWithdrawal(req: WithdrawalRequest): Promise<Payout> {
  const { spaceId, userId, amountKobo } = req;
  if (!Number.isSafeInteger(amountKobo) || amountKobo < MIN_PAYOUT_KOBO) {
    throw new AppError(422, 'BELOW_MIN_PAYOUT', `The minimum withdrawal is ₦${(MIN_PAYOUT_KOBO / 100).toLocaleString('en-NG')}`);
  }
  const breakdown = computeWithdrawal(amountKobo);

  const [space, user, account] = await Promise.all([
    db.space.findUnique({ where: { id: spaceId } }),
    db.user.findUnique({ where: { id: userId } }),
    db.bankAccount.findUnique({ where: { spaceId } }),
  ]);
  if (!space || !user) throw notFound('Space not found');
  if (space.payoutsFrozen) throw new AppError(423, 'PAYOUTS_FROZEN', 'Withdrawals for this space are frozen');
  if (!canWithdraw(user)) {
    throw forbidden('Complete identity verification before withdrawing', 'KYC_NOT_VERIFIED');
  }
  if (!account?.bachsDestinationId || account.bachsAccountId !== user.bachsAccountId) {
    throw conflict('NO_PAYOUT_ACCOUNT', 'Add and verify your payout bank account before withdrawing');
  }
  if (account.cooldownUntil && account.cooldownUntil > new Date()) {
    throw conflict('ACCOUNT_COOLDOWN', 'Withdrawals are on hold for 24 hours after a payout account change');
  }

  const reference = await uniquePayoutReference();

  let payout: Payout;
  try {
    payout = await db.$transaction(
      async (tx) => {
        await lockSpace(tx, spaceId);

        const active = await tx.payout.findUnique({ where: { activeSpaceId: spaceId }, select: { reference: true } });
        if (active) throw new WithdrawalInProgressError(active.reference);

        const balance = await getSpaceBalance(spaceId, tx);
        if (amountKobo > balance) {
          throw new AppError(422, 'INSUFFICIENT_BALANCE', 'The amount is more than the space’s available balance', [
            { field: 'amount', issue: `available balance is ${balance} kobo` },
          ]);
        }

        const created = await tx.payout.create({
          data: {
            spaceId,
            amount: breakdown.gross,
            feeKobo: breakdown.fee,
            netKobo: breakdown.net,
            reference,
            status: 'pending',
            activeSpaceId: spaceId,
            accountMasked: `${account.bankName} ${account.accountNumberMasked}`,
            note: req.note,
            requestedById: userId,
            provider: getPaymentProvider().name,
            providerAccountId: user.bachsAccountId,
          },
        });
        await debit(tx, created);
        await writeAudit(
          spaceId,
          { id: userId, name: user.name, role: 'lead' },
          'payout_requested',
          `Requested a ₦${(amountKobo / 100).toLocaleString('en-NG')} withdrawal (${reference})`,
          tx,
        );
        return created;
      },
      { timeout: 15_000 },
    );
  } catch (err) {
    // The unique index caught a race the lock should already have prevented.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new WithdrawalInProgressError();
    throw err;
  }

  logger.info({ ref: reference, spaceId, gross: breakdown.gross, fee: breakdown.fee }, 'withdrawal created');
  await dispatchPayout(payout.id);
  return db.payout.findUniqueOrThrow({ where: { id: payout.id } });
}

async function debit(tx: Tx, p: Payout): Promise<void> {
  await appendLedgerEntry(tx, {
    spaceId: p.spaceId,
    payoutId: p.id,
    type: 'payout',
    direction: 'debit',
    amountKobo: p.netKobo,
    grossKobo: p.amount,
    feeKobo: p.feeKobo,
    netKobo: p.netKobo,
    reference: p.reference,
    description: `Withdrawal to ${p.accountMasked}`,
  });
  await appendLedgerEntry(tx, {
    spaceId: p.spaceId,
    payoutId: p.id,
    type: 'payout_fee',
    direction: 'debit',
    amountKobo: p.feeKobo,
    reference: p.reference,
    description: 'Withdrawal fee',
  });
}

async function lockPayout(tx: Tx, payoutId: string): Promise<Payout> {
  await tx.$queryRaw`SELECT "id" FROM "payouts" WHERE "id" = ${payoutId} FOR UPDATE`;
  return tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
}

/**
 * Send a pending withdrawal to the provider. Safe to call repeatedly (the
 * reconciliation job does, for anything stuck in `pending`): the provider call
 * is idempotent on our reference, and the state change is guarded.
 */
export async function dispatchPayout(payoutId: string): Promise<void> {
  const payout = await db.payout.findUnique({ where: { id: payoutId } });
  if (!payout || payout.status !== 'pending') return;
  const account = await db.bankAccount.findUnique({ where: { spaceId: payout.spaceId } });
  if (!payout.providerAccountId || !account?.bachsDestinationId) {
    await failPayout(payout.id, 'No verified payout account on file');
    return;
  }

  try {
    const result = await getPaymentProvider().initiatePayout({
      accountId: payout.providerAccountId,
      destinationId: account.bachsDestinationId,
      amountKobo: payout.netKobo,
      reference: payout.reference,
    });
    await db.$transaction(async (tx) => {
      const p = await lockPayout(tx, payout.id);
      if (p.status !== 'pending') return;
      assertPayoutTransition('pending', 'processing');
      await tx.payout.update({
        where: { id: p.id },
        data: {
          status: 'processing',
          processingAt: new Date(),
          providerPayoutId: result.providerPayoutId,
          providerFeeKobo: result.providerFeeKobo,
        },
      });
    });
    logger.info({ ref: payout.reference, providerPayoutId: result.providerPayoutId, state: result.state }, 'withdrawal dispatched');
    if (result.state === 'succeeded') await completePayout(payout.reference, result.providerFeeKobo);
    if (result.state === 'failed') await failPayout(payout.id, result.failureReason ?? 'The bank could not complete the transfer');
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      const reason =
        err.code === 'INSUFFICIENT_BALANCE'
          ? 'Recent payments are still settling. Try again later.'
          : err.code === 'DESTINATION_PENDING_REVIEW'
            ? 'Your payout account is still being reviewed.'
            : err.message;
      await failPayout(payout.id, reason, err.code ?? undefined);
      return;
    }
    // Timeout / 5xx: the payout may exist. Leave it pending; reconciliation
    // retries with the same idempotency key, which replays instead of paying twice.
    logger.warn({ ref: payout.reference, err: (err as Error).message }, 'withdrawal dispatch deferred');
  }
}

/** payout.paid — idempotent. */
export async function completePayout(reference: string, providerFeeKobo?: number | null): Promise<boolean> {
  const done = await db.$transaction(async (tx) => {
    const found = await tx.payout.findUnique({ where: { reference }, select: { id: true } });
    if (!found) return null;
    const p = await lockPayout(tx, found.id);
    if (p.status === 'success') return null;
    if (!canTransitionPayout(p.status, 'success')) {
      logger.error({ ref: reference, status: p.status }, 'success reported for a withdrawal already closed');
      return null;
    }
    return tx.payout.update({
      where: { id: p.id },
      data: {
        status: 'success',
        settledAt: new Date(),
        activeSpaceId: null,
        ...(providerFeeKobo !== undefined && providerFeeKobo !== null ? { providerFeeKobo } : {}),
      },
    });
  });
  if (!done) return false;

  logger.info({ ref: reference }, 'withdrawal succeeded');
  await settleWithdrawalFee(done.id).catch((err) => logger.warn({ ref: reference, err: (err as Error).message }, 'fee settlement deferred'));
  await notifyReps(done, 'success');
  return true;
}

/** payout.failed, or a refusal at dispatch — idempotent. A failure after success is a reversal. */
export async function failPayoutByReference(reference: string, reason: string): Promise<boolean> {
  const p = await db.payout.findUnique({ where: { reference }, select: { id: true } });
  if (!p) return false;
  return failPayout(p.id, reason);
}

export async function failPayout(payoutId: string, reason: string, code?: string): Promise<boolean> {
  const done = await db.$transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    const to = p.status === 'success' ? 'reversed' : 'failed';
    if (!canTransitionPayout(p.status, to)) return null;

    await lockSpace(tx, p.spaceId);
    const updated = await tx.payout.update({
      where: { id: p.id },
      data: {
        status: to,
        activeSpaceId: null,
        failureReason: reason.slice(0, 300),
        ...(to === 'reversed' ? { reversedAt: new Date() } : { failedAt: new Date() }),
      },
    });
    // Restore the space's balance in full: what was sent AND the fee.
    await appendLedgerEntry(tx, {
      spaceId: p.spaceId,
      payoutId: p.id,
      type: 'payout_reversal',
      direction: 'credit',
      amountKobo: p.amount,
      grossKobo: p.amount,
      feeKobo: p.feeKobo,
      netKobo: p.netKobo,
      reference: p.reference,
      description: to === 'reversed' ? 'Withdrawal reversed by the bank' : 'Withdrawal failed — balance restored',
    });
    return updated;
  });
  if (!done) return false;

  logger.warn({ ref: done.reference, status: done.status, reason, code }, 'withdrawal failed — balance restored');
  // A reversed withdrawal whose fee had already been swept: give the fee back
  // to the rep's provider account, since the ledger restored it to the space.
  if (done.status === 'reversed' && done.feeSettledAt && done.feeSettlementKobo && done.providerAccountId) {
    await getPaymentProvider()
      .settleFee({ accountId: done.providerAccountId, amountKobo: -done.feeSettlementKobo, reference: `${done.reference}-REV` })
      .catch((err) => logger.error({ ref: done.reference, err: (err as Error).message }, 'fee refund on reversal failed — reconcile by hand'));
  }
  await notifyReps(done, 'failed');
  return true;
}

/**
 * After a successful withdrawal the rep's provider account has been debited
 * net + the provider's own payout fee; the ledger debited net + Duevy's fee.
 * Moving (Duevy fee − provider fee) to the platform makes the two agree.
 */
export async function settleWithdrawalFee(payoutId: string): Promise<void> {
  const p = await db.payout.findUnique({ where: { id: payoutId } });
  if (!p || p.status !== 'success' || p.feeSettledAt || !p.providerAccountId) return;
  const amount = p.feeKobo - (p.providerFeeKobo ?? 0);
  if (amount !== 0) {
    await getPaymentProvider().settleFee({ accountId: p.providerAccountId, amountKobo: amount, reference: p.reference });
  }
  await db.payout.update({ where: { id: p.id }, data: { feeSettledAt: new Date(), feeSettlementKobo: amount } });
  logger.info({ ref: p.reference, amount }, 'withdrawal fee settled');
}

/** Reconciliation: resolve a processing withdrawal from the provider's own record. */
export async function refreshPayout(payoutId: string): Promise<void> {
  const p = await db.payout.findUnique({ where: { id: payoutId } });
  if (!p || p.status !== 'processing' || !p.providerPayoutId || !p.providerAccountId) return;
  const result = await getPaymentProvider().getPayout(p.providerAccountId, p.providerPayoutId);
  if (result.state === 'succeeded') await completePayout(p.reference, result.providerFeeKobo);
  else if (result.state === 'failed') await failPayout(p.id, result.failureReason ?? 'The bank could not complete the transfer');
}

async function notifyReps(p: Payout, outcome: 'success' | 'failed'): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId: p.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    outcome === 'success'
      ? {
          kind: 'payout_completed',
          title: 'Withdrawal completed',
          detail: `₦${(p.netKobo / 100).toLocaleString('en-NG')} was sent to ${p.accountMasked}.`,
          href: '/dashboard/payout',
        }
      : {
          kind: 'system',
          tone: 'rose',
          title: p.status === 'reversed' ? 'Withdrawal reversed' : 'Withdrawal failed',
          detail: `Your ₦${(p.amount / 100).toLocaleString('en-NG')} withdrawal did not go through and has been returned to the space balance.`,
          href: '/dashboard/payout',
        },
  ).catch(() => {});
}

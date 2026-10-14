import { Prisma, type Payout, type RepRole, type Space } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { db } from '../config/db';
import { AppError, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { computeWithdrawal, generatePayoutReference, MIN_PAYOUT_KOBO } from '../lib/money';
import { assertPayoutTransition, canTransitionPayout } from '../lib/stateMachine';
import { notifyMany } from '../lib/notifications';
import { writeAudit } from '../lib/audit';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { appendLedgerEntry, getDueBalance, getSpaceBalance, lockSpace } from './ledger.service';
import { canWithdraw } from './kyc.service';
import { destinationFor, oneOffDestination } from './beneficiary.service';
import { assertPassword, getSignatoryIds, REQUIRED_SIGNATORIES } from './signatory.service';

/**
 * Withdrawals: a space's lead rep moves the space's balance to one of its
 * beneficiaries — any bank account the space has added. A co-rep can withdraw
 * a due's collections when the lead has assigned that due to them. Either way
 * the money leaves the LEAD rep's provider account, where collections settle.
 *
 *   gross = what the rep asks for, debited from the space's ledger
 *   fee   = ₦100 (< ₦50,000) or ₦200 (≥ ₦50,000), deducted from the gross
 *   net   = gross − fee, sent to the bank
 *
 * Safety, in order:
 *  0. The space's authorisation, by its withdrawalAuthMode:
 *     - pin: the 4-digit security code the lead rep set must be quoted (5
 *       wrong attempts lock it for 30 minutes).
 *     - multisig: the withdrawal is created `awaiting_approval` and only sent
 *       once 2 of the 3 signatories approve it with emailed one-time codes
 *       (withdrawalApproval.service). Its funds are reserved meanwhile.
 *     A security change (forgotten-code reset, signatory change, multisig
 *     switched off) holds withdrawals for 24 hours.
 *  1. Idempotency-Key on the route (a retried request replays).
 *  2. A transaction-scoped advisory lock per space: the balance check and the
 *     ledger debit happen atomically, so two requests can't both spend it.
 *  3. Payout.activeSpaceId is unique: a second in-flight withdrawal for the
 *     same space is impossible even if the lock were bypassed.
 *  4. The ledger is debited when the withdrawal is CREATED. A failure or
 *     reversal credits the full gross back (payout_reversal).
 *  5. The provider call uses our reference as its idempotency key.
 *
 * Status: [awaiting_approval →] pending → processing → success | failed | reversed;
 *         awaiting_approval → cancelled.
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
  /** Draw on one due's collections. Required for a co-rep (the due must be
   *  assigned to them); the lead omits it to draw on the whole space. */
  dueId?: string;
  /** Where it goes: a saved beneficiary, or a one-off account that isn't saved. */
  beneficiaryId?: string;
  account?: { bankCode: string; accountNumber: string };
  note?: string;
  /** The space's 4-digit withdrawal security code (set by its lead rep). `pin` mode only. */
  pin?: string;
}

/** How long a multisig withdrawal waits for its signatures before it is cancelled. */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 30 * 60 * 1000;
/** After a "forgot code" reset, withdrawals wait this long so a stolen
 *  password can't be turned straight into a withdrawal. */
export const PIN_RESET_HOLD_MS = 24 * 60 * 60 * 1000;

const SEQUENTIAL_PINS = new Set(['0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321', '3210']);

/** Repeated digits (1111) and straight runs (1234, 4321) are refused. */
export function isWeakPin(pin: string): boolean {
  return /^(\d)\1{3}$/.test(pin) || SEQUENTIAL_PINS.has(pin);
}

/** Prisma data that wipes a space's withdrawal code — used whenever the lead
 *  rep changes, so a new lead always sets their own. */
export const CLEARED_PIN = {
  withdrawalPinHash: null,
  withdrawalPinSetAt: null,
  withdrawalPinFailedAttempts: 0,
  withdrawalPinLockedUntil: null,
  withdrawalPinHoldUntil: null,
} satisfies Prisma.SpaceUpdateInput;

/** Check a code against the space's hash. Wrong guesses are counted
 *  atomically; the fifth locks the code for PIN_LOCK_MS. */
async function checkPin(space: Space, pin: string): Promise<void> {
  if (!space.withdrawalPinHash) {
    throw forbidden('Set a withdrawal security code on the Payout page first.', 'WITHDRAWAL_PIN_NOT_SET');
  }
  if (space.withdrawalPinLockedUntil && space.withdrawalPinLockedUntil > new Date()) {
    throw new AppError(423, 'WITHDRAWAL_PIN_LOCKED', 'Too many wrong security codes. Try again in 30 minutes, or reset your code.');
  }
  if (await bcrypt.compare(pin, space.withdrawalPinHash)) {
    if (space.withdrawalPinFailedAttempts > 0) {
      await db.space.update({ where: { id: space.id }, data: { withdrawalPinFailedAttempts: 0, withdrawalPinLockedUntil: null } });
    }
    return;
  }
  const { withdrawalPinFailedAttempts: attempts } = await db.space.update({
    where: { id: space.id },
    data: { withdrawalPinFailedAttempts: { increment: 1 } },
    select: { withdrawalPinFailedAttempts: true },
  });
  if (attempts >= PIN_MAX_ATTEMPTS) {
    await db.space.update({
      where: { id: space.id },
      data: { withdrawalPinFailedAttempts: 0, withdrawalPinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) },
    });
    logger.warn({ spaceId: space.id }, 'withdrawal security code locked after repeated failures');
    throw new AppError(423, 'WITHDRAWAL_PIN_LOCKED', 'Too many wrong security codes. Try again in 30 minutes, or reset your code.');
  }
  throw new AppError(403, 'INVALID_WITHDRAWAL_PIN', 'The security code is incorrect', [
    { field: 'pin', issue: `incorrect; ${PIN_MAX_ATTEMPTS - attempts} attempt(s) left` },
  ]);
}

/** No hold in force, then whatever the space's mode needs up front: the right
 *  code (pin), or a full set of signatories to approve it later (multisig). */
async function verifyAuthorisation(space: Space, pin: string | undefined): Promise<void> {
  if (space.withdrawalPinHoldUntil && space.withdrawalPinHoldUntil > new Date()) {
    throw new AppError(423, 'WITHDRAWAL_PIN_HOLD', 'Withdrawal security changed recently. Withdrawals reopen 24 hours after the change.', [
      { field: 'pin', issue: `available from ${space.withdrawalPinHoldUntil.toISOString()}` },
    ]);
  }
  if (space.withdrawalAuthMode === 'multisig') {
    if ((await getSignatoryIds(space.id)).length < REQUIRED_SIGNATORIES) {
      throw new AppError(409, 'SIGNATORIES_INCOMPLETE', 'This space needs 3 signatories to withdraw. The lead rep must nominate two co-reps as signatories.');
    }
    return;
  }
  if (!pin) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter the withdrawal security code', [{ field: 'pin', issue: 'required' }]);
  }
  await checkPin(space, pin);
}

/** The lead may draw on the whole space or any due; a co-rep only on a due assigned to them. */
async function authoriseScope(req: WithdrawalRequest, role: RepRole) {
  if (!req.dueId) {
    if (role !== 'lead') throw forbidden('Choose one of the dues assigned to you to withdraw from', 'DUE_REQUIRED');
    return null;
  }
  const due = await db.due.findUnique({ where: { id: req.dueId }, select: { id: true, spaceId: true, title: true, assignedRepId: true } });
  if (!due || due.spaceId !== req.spaceId) throw notFound('Due not found');
  if (role !== 'lead' && due.assignedRepId !== req.userId) {
    throw forbidden('You can only withdraw from dues assigned to you', 'DUE_NOT_ASSIGNED');
  }
  return due;
}

export type PinChange = 'set' | 'changed' | 'reset';

/**
 * The lead rep sets their space's withdrawal code. Always needs the account
 * password. A first code is just set; changing one also needs the current
 * code; `forgot` replaces it without the current code but starts a 24h hold.
 */
export async function setWithdrawalPinByRep(input: {
  spaceId: string;
  userId: string;
  pin: string;
  password: string;
  currentPin?: string;
  forgot?: boolean;
}): Promise<{ change: PinChange; holdUntil: Date | null }> {
  await assertPassword(input.userId, input.password);
  const space = await db.space.findUnique({ where: { id: input.spaceId } });
  if (!space) throw notFound('Space not found');
  if (isWeakPin(input.pin)) {
    throw new AppError(422, 'WEAK_PIN', 'Choose a less predictable code', [{ field: 'pin', issue: 'too easy to guess' }]);
  }

  let change: PinChange;
  let holdUntil: Date | null = space.withdrawalPinHoldUntil && space.withdrawalPinHoldUntil > new Date() ? space.withdrawalPinHoldUntil : null;
  if (!space.withdrawalPinHash) {
    change = 'set';
  } else if (input.forgot) {
    change = 'reset';
    holdUntil = new Date(Date.now() + PIN_RESET_HOLD_MS);
  } else {
    if (!input.currentPin) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Enter your current code, or reset it if you forgot it', [{ field: 'currentPin', issue: 'required' }]);
    }
    await checkPin(space, input.currentPin);
    change = 'changed';
  }

  await db.space.update({
    where: { id: space.id },
    data: {
      withdrawalPinHash: await bcrypt.hash(input.pin, 10),
      withdrawalPinSetAt: new Date(),
      withdrawalPinFailedAttempts: 0,
      withdrawalPinLockedUntil: null,
      withdrawalPinHoldUntil: holdUntil,
    },
  });
  return { change, holdUntil };
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

  const [space, user, rep, lead] = await Promise.all([
    db.space.findUnique({ where: { id: spaceId } }),
    db.user.findUnique({ where: { id: userId } }),
    db.spaceRep.findUnique({ where: { userId_spaceId: { userId, spaceId } } }),
    db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: true } }),
  ]);
  if (!space || !user) throw notFound('Space not found');
  if (!rep) throw forbidden('You are not a rep of this space');
  if (user.isSuspended || user.isDeactivated) {
    throw forbidden('Your account is suspended', 'ACCOUNT_SUSPENDED');
  }
  const due = await authoriseScope(req, rep.role);
  if (space.payoutsFrozen) throw new AppError(423, 'PAYOUTS_FROZEN', 'Withdrawals for this space are frozen');
  await verifyAuthorisation(space, req.pin);
  if (user.kycStatus !== 'verified') {
    throw forbidden('Complete identity verification before withdrawing', 'KYC_NOT_VERIFIED');
  }
  // Collections settle into the lead rep's account, so that is what pays out.
  if (!lead || !canWithdraw(lead.user)) {
    throw forbidden(
      rep.role === 'lead' ? 'Complete identity verification before withdrawing' : "The lead rep's account can't make withdrawals yet",
      rep.role === 'lead' ? 'KYC_NOT_VERIFIED' : 'LEAD_KYC_NOT_VERIFIED',
    );
  }
  const accountId = lead.user.bachsAccountId!;
  // canWithdraw guarantees a Bachs account. The destination is fixed on the
  // payout now so a later change to the beneficiary can't redirect it.
  const target = await resolveTarget(req, accountId);
  const needsApproval = space.withdrawalAuthMode === 'multisig';

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
        if (due) {
          const dueBalance = await getDueBalance(due.id, tx);
          if (amountKobo > dueBalance) {
            throw new AppError(422, 'INSUFFICIENT_BALANCE', `The amount is more than what is left of "${due.title}"`, [
              { field: 'amount', issue: `available balance for this due is ${Math.max(0, dueBalance)} kobo` },
            ]);
          }
        }

        const created = await tx.payout.create({
          data: {
            spaceId,
            amount: breakdown.gross,
            feeKobo: breakdown.fee,
            netKobo: breakdown.net,
            reference,
            dueId: due?.id ?? null,
            status: needsApproval ? 'awaiting_approval' : 'pending',
            approvalExpiresAt: needsApproval ? new Date(Date.now() + APPROVAL_WINDOW_MS) : null,
            activeSpaceId: spaceId,
            accountMasked: `${target.bankName} ${target.accountNumberMasked}`,
            accountName: target.accountName,
            beneficiaryId: target.beneficiaryId,
            destinationId: target.destinationId,
            note: req.note,
            requestedById: userId,
            provider: getPaymentProvider().name,
            providerAccountId: accountId,
          },
        });
        await debit(tx, created);
        await writeAudit(
          spaceId,
          { id: userId, name: user.name, role: rep.role },
          'payout_requested',
          `Requested a ₦${(amountKobo / 100).toLocaleString('en-NG')} withdrawal${due ? ` from "${due.title}"` : ''} to ${target.accountName} (${reference})${needsApproval ? ', awaiting signatory approval' : ''}`,
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

  logger.info({ ref: reference, spaceId, gross: breakdown.gross, fee: breakdown.fee, status: payout.status }, 'withdrawal created');
  if (payout.status === 'pending') await dispatchPayout(payout.id);
  return db.payout.findUniqueOrThrow({ where: { id: payout.id } });
}

async function resolveTarget(req: WithdrawalRequest, accountId: string) {
  if (req.beneficiaryId) {
    const b = await db.payoutBeneficiary.findFirst({ where: { id: req.beneficiaryId, spaceId: req.spaceId } });
    if (!b) throw new AppError(404, 'BENEFICIARY_NOT_FOUND', 'That beneficiary no longer exists');
    return {
      beneficiaryId: b.id,
      bankName: b.bankName,
      accountNumberMasked: b.accountNumberMasked,
      accountName: b.accountName,
      destinationId: await destinationFor(b, accountId),
    };
  }
  if (req.account) {
    return { beneficiaryId: null, ...(await oneOffDestination(accountId, req.account.bankCode, req.account.accountNumber)) };
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Choose a beneficiary or enter an account for this withdrawal');
}

async function debit(tx: Tx, p: Payout): Promise<void> {
  await appendLedgerEntry(tx, {
    spaceId: p.spaceId,
    dueId: p.dueId,
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
    dueId: p.dueId,
    payoutId: p.id,
    type: 'payout_fee',
    direction: 'debit',
    amountKobo: p.feeKobo,
    reference: p.reference,
    description: 'Withdrawal fee',
  });
}

export async function lockPayout(tx: Tx, payoutId: string): Promise<Payout> {
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
  if (!payout.providerAccountId || !payout.destinationId) {
    await failPayout(payout.id, 'No payout destination on this withdrawal');
    return;
  }

  try {
    const result = await getPaymentProvider().initiatePayout({
      accountId: payout.providerAccountId,
      destinationId: payout.destinationId,
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
            ? 'This beneficiary account is still being reviewed.'
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
    await restoreBalance(tx, p, to === 'reversed' ? 'Withdrawal reversed by the bank' : 'Withdrawal failed — balance restored');
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

/** Credit a withdrawal's full gross (sent amount and fee) back to the space, and its due. */
async function restoreBalance(tx: Tx, p: Payout, description: string): Promise<void> {
  await appendLedgerEntry(tx, {
    spaceId: p.spaceId,
    dueId: p.dueId,
    payoutId: p.id,
    type: 'payout_reversal',
    direction: 'credit',
    amountKobo: p.amount,
    grossKobo: p.amount,
    feeKobo: p.feeKobo,
    netKobo: p.netKobo,
    reference: p.reference,
    description,
  });
}

/**
 * A multisig withdrawal that never reached the bank: rejected by a signatory,
 * withdrawn by its requester, or not approved in time. Idempotent; restores
 * the reserved balance in full.
 */
export async function cancelPayout(payoutId: string, reason: string): Promise<Payout | null> {
  const done = await db.$transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (!canTransitionPayout(p.status, 'cancelled')) return null;
    await lockSpace(tx, p.spaceId);
    const updated = await tx.payout.update({
      where: { id: p.id },
      data: { status: 'cancelled', activeSpaceId: null, approvalExpiresAt: null, cancelledAt: new Date(), failureReason: reason.slice(0, 300) },
    });
    await restoreBalance(tx, p, 'Withdrawal cancelled — balance restored');
    await tx.payoutOtp.deleteMany({ where: { payoutId: p.id } });
    return updated;
  });
  if (!done) return null;
  logger.info({ ref: done.reference, reason }, 'withdrawal cancelled — balance restored');
  await notifyReps(done, 'cancelled');
  return done;
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

async function notifyReps(p: Payout, outcome: 'success' | 'failed' | 'cancelled'): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId: p.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    outcome === 'success'
      ? {
          kind: 'payout_completed',
          title: 'Withdrawal completed',
          detail: `₦${(p.netKobo / 100).toLocaleString('en-NG')} was sent to ${p.accountName ? `${p.accountName}, ` : ''}${p.accountMasked}.`,
          href: '/dashboard/payout',
        }
      : outcome === 'cancelled'
        ? {
            kind: 'system',
            tone: 'rose',
            title: 'Withdrawal cancelled',
            detail: `The ₦${(p.amount / 100).toLocaleString('en-NG')} withdrawal (${p.reference}) was cancelled: ${p.failureReason}. It has been returned to the space balance.`,
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

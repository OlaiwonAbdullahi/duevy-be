import { Prisma, type Payout, type RepRole, type Space } from '@prisma/client';
import { hashPassword, verifyPassword } from '../lib/password';
import { db } from '../config/db';
import { AppError, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { computeWithdrawal, generatePayoutReference, MAX_PAYOUT_KOBO, MAX_TRANSFER_KOBO, MIN_PAYOUT_KOBO } from '../lib/money';
import { assertPayoutTransition, canTransitionPayout } from '../lib/stateMachine';
import { notifyMany } from '../lib/notifications';
import { writeAudit } from '../lib/audit';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { appendLedgerEntry, getDueAvailability, getSpaceBalance, lockSpace } from './ledger.service';
import { oneOffDestination } from './beneficiary.service';
import { canWithdraw } from './kyc.service';
import { payoutLedgerDescription, payoutSummary, transferNarration } from '../lib/narration';
import { getKycPolicy } from './kycPolicy.service';
import {
  createSweep,
  dailyLimitError,
  dispatchSweep,
  ensureSpaceAccount,
  getBusinessSweepAllowanceKobo,
  getDailyAllowanceKobo,
  getUnsweptKobo,
  lockBusinessSweeps,
  getWithdrawalAllowanceKobo,
} from './sweep.service';
import { decrypt, encrypt } from '../lib/encryption';
import { assertPassword, getSignatoryIds, REQUIRED_SIGNATORIES } from './signatory.service';
import { env } from '../config/env';
import { sendWithdrawalUpdateEmail, type WithdrawalUpdate } from '../lib/email';

/**
 * Withdrawals: a space's lead rep moves the space's balance to one of its
 * beneficiaries — any bank account the space has added. A co-rep can withdraw
 * a due's collections when the lead has assigned that due to them. Either way
 * the money is the SPACE's and leaves the space's own 9jaPay account; when
 * part of it is still in Duevy's business account, a sweep moves it first and
 * the withdrawal waits `pending` for it (sweep.service).
 *
 *   gross = what the rep asks for, debited from the space's ledger
 *   fee   = 9jaPay's transfer charge (₦10 / ₦15 / ₦20 by amount), deducted
 *           from the gross
 *   net   = gross − fee, sent to the bank
 *
 * Limits, all checked up front before anything is debited: ₦1,000 to
 * ₦500,000 per withdrawal; ₦5M withdrawn per space per day; and the space
 * account's ₦10M a day of sweeps in + withdrawals out.
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
  if (await verifyPassword(pin, space.withdrawalPinHash)) {
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
/**
 * A rep applicant chooses their space's withdrawal code during onboarding,
 * before the space exists. It's kept on the application and becomes the
 * space's code on approval (admin.ts). Re-saving while pending replaces it.
 */
export async function setApplicationWithdrawalPin(input: { userId: string; pin: string; password: string }): Promise<void> {
  await assertPassword(input.userId, input.password);
  if (isWeakPin(input.pin)) {
    throw new AppError(422, 'WEAK_PIN', 'Choose a less predictable code', [{ field: 'pin', issue: 'too easy to guess' }]);
  }
  const app = await db.repApplication.findUnique({ where: { userId: input.userId }, select: { status: true } });
  if (!app || app.status !== 'pending') {
    throw new AppError(409, 'NOT_PENDING', 'You have no pending rep application. Set your code from your space instead.');
  }
  await db.repApplication.update({
    where: { userId: input.userId },
    data: { withdrawalPinHash: await hashPassword(input.pin, 10) },
  });
}

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
      withdrawalPinHash: await hashPassword(input.pin, 10),
      withdrawalPinSetAt: new Date(),
      withdrawalPinFailedAttempts: 0,
      withdrawalPinLockedUntil: null,
      withdrawalPinHoldUntil: holdUntil,
    },
  });
  return { change, holdUntil };
}

export async function quoteWithdrawal(spaceId: string, amountKobo: number) {
  const b = computeWithdrawal(amountKobo);
  return {
    amount: b.gross,
    fee: b.fee,
    // `fee` split: 9jaPay's transfer charge and the 7.5% VAT on it.
    feeCharge: b.charge,
    feeVat: b.vat,
    net: b.net,
    minPayout: MIN_PAYOUT_KOBO,
    maxPayout: MAX_PAYOUT_KOBO,
    belowMinimum: amountKobo < MIN_PAYOUT_KOBO,
    aboveMaximum: amountKobo > MAX_PAYOUT_KOBO,
    dailyRemaining: await getWithdrawalAllowanceKobo(spaceId),
  };
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
  if (amountKobo > MAX_PAYOUT_KOBO) {
    throw new AppError(
      422,
      'ABOVE_MAX_PAYOUT',
      `The most you can withdraw at once is ₦${(MAX_PAYOUT_KOBO / 100).toLocaleString('en-NG')}. Split it into several withdrawals.`,
    );
  }
  const breakdown = computeWithdrawal(amountKobo);

  const [space, user, rep, lead, kycPolicy] = await Promise.all([
    db.space.findUnique({ where: { id: spaceId } }),
    db.user.findUnique({ where: { id: userId } }),
    db.spaceRep.findUnique({ where: { userId_spaceId: { userId, spaceId } } }),
    db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: true } }),
    getKycPolicy(),
  ]);
  if (!space || !user) throw notFound('Space not found');
  if (!rep) throw forbidden('You are not a rep of this space');
  if (user.isSuspended || user.isDeactivated) {
    throw forbidden('Your account is suspended', 'ACCOUNT_SUSPENDED');
  }
  const due = await authoriseScope(req, rep.role);
  if (space.payoutsFrozen) throw new AppError(423, 'PAYOUTS_FROZEN', 'Withdrawals for this space are frozen');
  await verifyAuthorisation(space, req.pin);
  // The money is the space's; the rep acting on it must have passed every
  // check the current KYC policy requires (the same bar as collecting).
  // kycStatus alone is only the NIN check's status, which may not be required.
  if (!canWithdraw(user, kycPolicy)) {
    throw forbidden('Complete identity verification before withdrawing', 'KYC_NOT_VERIFIED');
  }
  if (!lead) throw forbidden('This space has no lead rep', 'NO_LEAD_REP');
  const funded = await ensureSpaceAccount(spaceId).catch(() => space);
  if (!funded.walletAccountNumber) {
    throw new AppError(409, 'SPACE_ACCOUNT_NOT_READY', "This space's account is still being set up. Try again shortly.");
  }
  // Fixed on the payout now so a later change to the beneficiary can't redirect it.
  const target = await resolveTarget(req);
  const needsApproval = space.withdrawalAuthMode === 'multisig';

  const reference = await uniquePayoutReference();
  let sweepId: string | null = null;
  const sweepIds: string[] = [];

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
          const dueAvailable = (await getDueAvailability(spaceId, tx)).get(due.id) ?? 0;
          if (amountKobo > dueAvailable) {
            throw new AppError(422, 'INSUFFICIENT_BALANCE', `The amount is more than what is left of "${due.title}"`, [
              { field: 'amount', issue: `available balance for this due is ${dueAvailable} kobo` },
            ]);
          }
        }

        // The space's ₦5M a day of withdrawals. What isn't in the space's
        // account yet has to be swept first, and the sweep and the withdrawal
        // both count against the account's own daily limit too.
        const withdrawable = await getWithdrawalAllowanceKobo(spaceId, tx);
        if (amountKobo > withdrawable) throw dailyLimitError(withdrawable);
        const unswept = await getUnsweptKobo(spaceId, tx);
        // What the space's account is missing for this withdrawal.
        const shortfall = Math.max(0, amountKobo - Math.max(0, balance - unswept));
        const accountAllowance = await getDailyAllowanceKobo(spaceId, tx);
        if (amountKobo + shortfall > accountAllowance) throw dailyLimitError(Math.min(withdrawable, Math.max(0, accountAllowance - shortfall)));
        if (unswept > 0) {
          await lockBusinessSweeps(tx);
          const business = await getBusinessSweepAllowanceKobo(tx);
          if (shortfall > business) {
            // Only what is already in the space's account can go today.
            const inAccount = Math.min(withdrawable, Math.max(0, balance - unswept) + business);
            throw new AppError(
              422,
              'DAILY_LIMIT_EXCEEDED',
              `Part of this space's money can't be moved into its account until tomorrow. ₦${(inAccount / 100).toLocaleString('en-NG')} can be withdrawn today.`,
              [{ field: 'amount', issue: `withdrawable today is ${inAccount} kobo` }],
            );
          }
          // A withdrawal moves ALL the space's unswept money into its account,
          // as far as today's limits allow, in transfers of at most
          // MAX_TRANSFER_KOBO. The first covers the shortfall (a withdrawal is
          // at most MAX_PAYOUT_KOBO), and only it holds the withdrawal back;
          // with no shortfall the withdrawal waits for none. Moving more than
          // needed also absorbs a few kobo the account may hold short of the
          // ledger (a 9jaPay charge Duevy didn't record).
          let left = Math.min(unswept, accountAllowance - amountKobo, business);
          while (left > 0) {
            const sweep = await createSweep(tx, spaceId, Math.min(left, MAX_TRANSFER_KOBO), 'withdrawal');
            sweepIds.push(sweep.id);
            if (shortfall > 0 && !sweepId) sweepId = sweep.id;
            left -= sweep.amountKobo;
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
            bankCode: target.bankCode,
            accountNumberEnc: encrypt(target.accountNumber),
            sweepId,
            note: req.note,
            requestedById: userId,
            provider: getPaymentProvider().name,
            providerPayoutId: getPaymentProvider().wireReference(reference),
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

  logger.info({ ref: reference, spaceId, gross: breakdown.gross, fee: breakdown.fee, status: payout.status, sweepId }, 'withdrawal created');
  // The sweeps go now even while signatories approve: moving the space's own
  // money into its own account is harmless if the withdrawal is cancelled.
  for (const id of sweepIds) await dispatchSweep(id);
  if (payout.status === 'pending') await dispatchPayout(payout.id);
  return db.payout.findUniqueOrThrow({ where: { id: payout.id } });
}

async function resolveTarget(req: WithdrawalRequest) {
  if (req.beneficiaryId) {
    const b = await db.payoutBeneficiary.findFirst({ where: { id: req.beneficiaryId, spaceId: req.spaceId } });
    if (!b) throw new AppError(404, 'BENEFICIARY_NOT_FOUND', 'That beneficiary no longer exists');
    return {
      beneficiaryId: b.id,
      bankCode: b.bankCode,
      bankName: b.bankName,
      accountNumber: decrypt(b.accountNumber),
      accountNumberMasked: b.accountNumberMasked,
      accountName: b.accountName,
    };
  }
  if (req.account) {
    const { bankCode, accountNumber } = req.account;
    return { beneficiaryId: null, bankCode, accountNumber, ...(await oneOffDestination(bankCode, accountNumber)) };
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
    description: payoutLedgerDescription(p),
  });
  // Ledger entries must be positive; skip a zero fee.
  if (p.feeKobo === 0) return;
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
 * Send a pending withdrawal from the space's account. Safe to call repeatedly
 * (the reconciliation job does, for anything stuck in `pending`): 9jaPay
 * refuses a second transfer under the same reference, and the state change
 * is guarded. A withdrawal waiting for a sweep stays pending until it lands.
 */
export async function dispatchPayout(payoutId: string): Promise<void> {
  const payout = await db.payout.findUnique({ where: { id: payoutId }, include: { sweep: true, space: true } });
  if (!payout || payout.status !== 'pending') return;
  if (payout.sweep && payout.sweep.status !== 'succeeded') {
    if (payout.sweep.status === 'failed') {
      await failPayout(payout.id, "The space's collections couldn't be moved into its account. Try again shortly.", 'SWEEP_FAILED');
    }
    return;
  }
  const { space } = payout;
  if (!payout.bankCode || !payout.accountNumberEnc || !space.walletAccountNumber || !space.walletAccountName) {
    await failPayout(payout.id, 'No destination on this withdrawal');
    return;
  }

  try {
    const result = await getPaymentProvider().initiateTransfer({
      from: { accountNumber: space.walletAccountNumber, accountName: space.walletAccountName },
      bankCode: payout.bankCode,
      accountNumber: decrypt(payout.accountNumberEnc),
      accountName: payout.accountName ?? '',
      amountKobo: payout.netKobo,
      reference: payout.reference,
      // The recipient's statement: "Duevy/<code> sent you NGN<amount>"; the reference travels as the payment reference.
      narration: transferNarration({ spaceCode: space.short, amountKobo: payout.netKobo }),
    });
    await db.$transaction(async (tx) => {
      const p = await lockPayout(tx, payout.id);
      if (p.status !== 'pending') return;
      assertPayoutTransition('pending', 'processing');
      await tx.payout.update({
        where: { id: p.id },
        data: { status: 'processing', processingAt: new Date(), providerPayoutId: result.providerReference },
      });
    });
    logger.info({ ref: payout.reference, state: result.state }, 'withdrawal dispatched');
    if (result.state === 'succeeded') await completePayout(payout.reference);
    if (result.state === 'failed') await failPayout(payout.id, result.failureReason ?? 'The bank could not complete the transfer');
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      const reason = err.code === 'ACCOUNT_UNVERIFIABLE' ? 'The bank could not verify this account.' : err.message;
      await failPayout(payout.id, reason, err.code ?? undefined);
      return;
    }
    // Timeout / 5xx: the transfer may exist. Leave it pending; reconciliation
    // resends under the same reference, which 9jaPay refuses as a duplicate.
    logger.warn({ ref: payout.reference, err: (err as Error).message }, 'withdrawal dispatch deferred');
  }
}

/** The transfer succeeded — idempotent. */
export async function completePayout(reference: string): Promise<boolean> {
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
      data: { status: 'success', settledAt: new Date(), activeSpaceId: null },
    });
  });
  if (!done) return false;

  logger.info({ ref: reference }, 'withdrawal succeeded');
  await notifyReps(done, 'success');
  return true;
}

/** The transfer failed, or was refused at dispatch — idempotent. A failure after success is a reversal. */
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

/** Reconciliation (and transfer events): resolve a withdrawal from 9jaPay's own record. */
export async function refreshPayout(payoutId: string): Promise<void> {
  const p = await db.payout.findUnique({ where: { id: payoutId } });
  if (!p || p.status !== 'processing') return;
  let result;
  try {
    result = await getPaymentProvider().getTransfer(p.reference);
  } catch (err) {
    // 9jaPay has no record of it: it never arrived, so send it again. The
    // reference stops a double send if it turns up after all.
    if (err instanceof ProviderError && err.code === 'NOT_FOUND') {
      const { count } = await db.payout.updateMany({ where: { id: p.id, status: 'processing' }, data: { status: 'pending', processingAt: null } });
      if (count === 1) {
        logger.warn({ ref: p.reference }, 'withdrawal unknown to 9jaPay — sending it again');
        await dispatchPayout(p.id);
      }
      return;
    }
    throw err;
  }
  if (result.state === 'succeeded') await completePayout(p.reference);
  else if (result.state === 'failed') await failPayout(p.id, result.failureReason ?? 'The bank could not complete the transfer');
}

/** Email every active rep of the space how a withdrawal ended; one failed email never blocks the rest. */
async function emailReps(p: Payout, outcome: WithdrawalUpdate['outcome']): Promise<void> {
  const [space, reps, requester, due] = await Promise.all([
    db.space.findUnique({ where: { id: p.spaceId }, select: { name: true } }),
    db.spaceRep.findMany({
      where: { spaceId: p.spaceId, user: { isDeactivated: false } },
      select: { userId: true, user: { select: { name: true, email: true } } },
    }),
    p.requestedById ? db.user.findUnique({ where: { id: p.requestedById }, select: { name: true } }) : null,
    p.dueId ? db.due.findUnique({ where: { id: p.dueId }, select: { title: true } }) : null,
  ]);
  const base = {
    outcome,
    spaceName: space?.name ?? 'your space',
    netKobo: p.netKobo,
    feeKobo: p.feeKobo,
    grossKobo: p.amount,
    destination: p.accountName ? `${p.accountName} · ${p.accountMasked}` : p.accountMasked,
    dueTitle: due?.title ?? null,
    requestedBy: requester?.name ?? 'A rep',
    reference: p.reference,
    reason: p.failureReason,
    at: p.settledAt ?? p.reversedAt ?? p.failedAt ?? p.cancelledAt ?? new Date(),
    link: `${env.FRONTEND_URL}/dashboard/payout`,
  };
  const sent = await Promise.allSettled(
    reps.map((r) => sendWithdrawalUpdateEmail(r.user.email, r.user.name, { ...base, viewerIsRequester: r.userId === p.requestedById })),
  );
  for (const [i, r] of sent.entries()) {
    if (r.status === 'rejected') logger.warn({ ref: p.reference, repId: reps[i]!.userId, err: (r.reason as Error)?.message }, 'withdrawal email failed');
  }
}

async function notifyReps(p: Payout, outcome: 'success' | 'failed' | 'cancelled'): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId: p.spaceId }, select: { userId: true } });
  // Every outcome is emailed to every rep too: money leaving the space is
  // something each of them should be able to spot. Best effort, never awaited
  // by the caller's result.
  await emailReps(p, outcome === 'failed' && p.status === 'reversed' ? 'reversed' : outcome).catch((err) =>
    logger.warn({ ref: p.reference, err: (err as Error).message }, 'withdrawal emails not sent'),
  );
  if (outcome === 'success') {
    // "You sent NGN3000 to Abdullahi Olaiwon" to whoever made it; the other reps aren't "you".
    const done = { ...p, status: 'success' };
    const requester = reps.filter((r) => r.userId === p.requestedById).map((r) => r.userId);
    const others = reps.filter((r) => r.userId !== p.requestedById).map((r) => r.userId);
    const base = { kind: 'payout_completed' as const, title: 'Withdrawal completed', href: '/dashboard/payout' };
    await Promise.all([
      notifyMany(requester, { ...base, detail: `${payoutSummary(done)}.` }),
      notifyMany(others, { ...base, detail: `${payoutSummary(done, { viewerIsRequester: false })}.` }),
    ]).catch(() => {});
    return;
  }
  await notifyMany(
    reps.map((r) => r.userId),
    outcome === 'cancelled'
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

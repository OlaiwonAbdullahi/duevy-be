import { transferNarration } from '../lib/narration';
import { Prisma, type Space, type Sweep, type SweepTrigger } from '@prisma/client';
import { randomInt } from 'crypto';
import { db } from '../config/db';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { DAILY_PAYOUT_LIMIT_KOBO, MAX_TRANSFER_KOBO } from '../lib/money';
import { isCurrentSpaceAccountName, randomSuffix, spaceAccountName } from '../lib/spaceAccountName';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { lockSpace } from './ledger.service';
// Circular with withdrawal.service, which is fine: each only calls the other
// inside functions, never while the modules load.
import { dispatchPayout } from './withdrawal.service';

/**
 * Space accounts and sweeps.
 *
 * Every space owns a permanent 9jaPay account. Students pay into one-time
 * accounts that settle into Duevy's business account; the sweep then moves
 * each space's share into the space's own account, once a day or straight
 * away when a withdrawal needs it. Withdrawals are paid out of the space's
 * account.
 *
 *   unswept  = the space's 9jaPay collections (ledger due_payment credits)
 *              − its sweeps that haven't failed
 *   in space account = ledger balance − unswept
 *
 * Money sent straight to the space account (directDeposit.service) is
 * credited to the ledger but never counted as unswept: it is already there.
 *
 * A sweep doesn't touch the ledger: the money is the space's either way, and
 * 9jaPay bills the transfer to Duevy (covered by the checkout processing
 * fee). Each space account may move at most DAILY_LIMIT_KOBO a day, counting
 * sweeps and direct deposits in and withdrawals out (Africa/Lagos days), and a space may
 * withdraw at most DAILY_PAYOUT_LIMIT_KOBO of that. 9jaPay refuses a single
 * transfer over MAX_TRANSFER_KOBO, so a large sweep goes as several.
 *
 * Status: pending → processing → succeeded | failed. A failed sweep simply
 * counts as unswept again; withdrawals that were waiting for it fail and
 * their balance is restored.
 */

type Tx = Prisma.TransactionClient;

export const DAILY_LIMIT_KOBO = 1_000_000_000; // ₦10,000,000
/** Daily sweeps run from this Lagos hour, when collections are quiet. */
const DAILY_SWEEP_HOUR_LAGOS = 2;
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no daylight saving

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateSweepReference(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `SWP${new Date().getUTCFullYear()}${out}`;
}

/** Midnight in Lagos today, as a UTC instant. */
export function startOfLagosDay(now = new Date()): Date {
  const day = 24 * 60 * 60 * 1000;
  return new Date(Math.floor((now.getTime() + LAGOS_OFFSET_MS) / day) * day - LAGOS_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// The space's own account
// ---------------------------------------------------------------------------

/**
 * Open the space's permanent account if it has none yet. Called when a space
 * is created and retried by the daily sweep; a space can't withdraw until it
 * has one. Returns the space as it now stands.
 */
export async function ensureSpaceAccount(spaceId: string): Promise<Space> {
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  if (space.walletAccountNumber) return space;

  // 9jaPay puts the business name in front itself: "DUEVY/<space name>-<suffix>".
  const accountName = await uniqueSpaceAccountName(space);
  const account = await getPaymentProvider().createSpaceAccount({ reference: space.id, accountName });
  // Only fill it in if nobody else did meanwhile; the loser's account is
  // unused and logged for cleanup.
  const { count } = await db.space.updateMany({
    where: { id: space.id, walletAccountNumber: null },
    data: {
      walletAccountId: account.accountId,
      walletAccountNumber: account.accountNumber,
      walletAccountName: account.accountName,
      walletBankName: account.bankName,
      walletBankCode: account.bankCode,
      walletCreatedAt: new Date(),
    },
  });
  if (count === 0) logger.warn({ spaceId, accountNumber: account.accountNumber }, 'space account opened twice — the second is unused');
  else logger.info({ spaceId, accountNumber: account.accountNumber }, 'space account opened');
  return db.space.findUniqueOrThrow({ where: { id: spaceId } });
}

/**
 * "<space name>-<3 letters>", with letters no other space's account name
 * uses with the same base. Checked against the names the bank shows, which
 * end in exactly what we sent.
 */
async function uniqueSpaceAccountName(space: Pick<Space, 'id' | 'name'>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = spaceAccountName(space.name, randomSuffix());
    const taken = await db.space.count({
      where: { id: { not: space.id }, walletAccountName: { endsWith: `/${name}`, mode: 'insensitive' } },
    });
    if (!taken) return name;
  }
  throw new AppError(409, 'ACCOUNT_NAME_EXHAUSTED', 'Could not find a free account name for this space');
}

/**
 * Give the space's account the current naming ("<space name>-<suffix>"),
 * e.g. after the space is renamed or for accounts opened before the suffix.
 * A no-op when the bank already shows a name in that form for the space's
 * current name, unless `force`. Returns the name the bank now shows.
 */
export async function renameSpaceAccount(spaceId: string, opts: { force?: boolean } = {}): Promise<{ renamed: boolean; accountName: string | null }> {
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  if (!space.walletAccountNumber) return { renamed: false, accountName: null };
  if (!opts.force && isCurrentSpaceAccountName(space.walletAccountName, space.name)) {
    return { renamed: false, accountName: space.walletAccountName };
  }
  const accountName = await uniqueSpaceAccountName(space);
  const shown = await getPaymentProvider().renameSpaceAccount(space.walletAccountNumber, accountName);
  await db.space.update({ where: { id: space.id }, data: { walletAccountName: shown.accountName } });
  logger.info({ spaceId, accountNumber: space.walletAccountNumber, from: space.walletAccountName, to: shown.accountName }, 'space account renamed');
  return { renamed: true, accountName: shown.accountName };
}

/** Best effort, after a space is renamed; scripts/renameSpaceAccounts catches any miss. */
export function renameSpaceAccountInBackground(spaceId: string): void {
  void renameSpaceAccount(spaceId).catch((err) =>
    logger.warn({ spaceId, err: (err as Error).message }, 'space account not renamed after the space was — run the rename script'),
  );
}

/** Best effort, after a space is created: a failure is retried by the daily sweep. */
export function openSpaceAccountInBackground(spaceId: string): void {
  void ensureSpaceAccount(spaceId).catch((err) =>
    logger.warn({ spaceId, err: (err as Error).message }, 'space account not opened yet — the sweep job will retry'),
  );
}

// ---------------------------------------------------------------------------
// Where a space's money is
// ---------------------------------------------------------------------------

/** The space's collections still sitting in Duevy's business account. */
export async function getUnsweptKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  const provider = getPaymentProvider().name;
  const rows = await tx.$queryRaw<{ collected: bigint | null; swept: bigint | null }[]>`
    SELECT
      (SELECT COALESCE(SUM(le."amountKobo"), 0)
         FROM "ledger_entries" le
         JOIN "due_payments" dp ON dp."id" = le."duePaymentId"
         JOIN "checkouts" c ON c."id" = dp."checkoutId"
        WHERE le."spaceId" = ${spaceId} AND le."type" = 'due_payment' AND c."provider" = ${provider})::bigint AS collected,
      (SELECT COALESCE(SUM("amountKobo"), 0)
         FROM "sweeps"
        WHERE "spaceId" = ${spaceId} AND "status" <> 'failed')::bigint AS swept`;
  const row = rows[0];
  return Math.max(0, Number(row?.collected ?? 0) - Number(row?.swept ?? 0));
}

/** What the space has withdrawn today (anything not failed, cancelled or reversed). */
export async function getDailyWithdrawnKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  const rows = await tx.$queryRaw<{ used: bigint | null }[]>`
    SELECT COALESCE(SUM("amount"), 0)::bigint AS used FROM "payouts"
     WHERE "spaceId" = ${spaceId} AND "provider" = ${getPaymentProvider().name}
       AND "status" NOT IN ('failed', 'cancelled', 'reversed') AND "requestedAt" >= ${startOfLagosDay()}`;
  return Number(rows[0]?.used ?? 0);
}

/**
 * Every sweep leaves from Duevy's business account, which 9jaPay lets send
 * NINEJAPAY_BUSINESS_DAILY_LIMIT_KOBO a Lagos day across all spaces. Callers
 * take this lock (after the space's) before reading the allowance and
 * recording a sweep, so two spaces can't both spend the last of it.
 */
export async function lockBusinessSweeps(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'sweeps:business'}, 0))`;
}

/** What the business account may still send in sweeps today. */
export async function getBusinessSweepAllowanceKobo(tx: Tx | typeof db = db): Promise<number> {
  const rows = await tx.$queryRaw<{ swept: bigint | null }[]>`
    SELECT COALESCE(SUM("amountKobo"), 0)::bigint AS swept FROM "sweeps"
     WHERE "status" <> 'failed' AND "createdAt" >= ${startOfLagosDay()}`;
  return Math.max(0, env.NINEJAPAY_BUSINESS_DAILY_LIMIT_KOBO - Number(rows[0]?.swept ?? 0));
}

/** What has been swept into the space's account today. */
async function getDailySweptKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  const rows = await tx.$queryRaw<{ swept: bigint | null }[]>`
    SELECT COALESCE(SUM("amountKobo"), 0)::bigint AS swept FROM "sweeps"
     WHERE "spaceId" = ${spaceId} AND "status" <> 'failed' AND "createdAt" >= ${startOfLagosDay()}`;
  return Number(rows[0]?.swept ?? 0);
}

/** What arrived in the space's account today straight from outside (direct deposits). */
async function getDailyDepositedKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  const rows = await tx.$queryRaw<{ deposited: bigint | null }[]>`
    SELECT COALESCE(SUM("amountKobo"), 0)::bigint AS deposited FROM "direct_deposits"
     WHERE "spaceId" = ${spaceId} AND "receivedAt" >= ${startOfLagosDay()}`;
  return Number(rows[0]?.deposited ?? 0);
}

/** What the space's account has moved today: sweeps and direct deposits in, withdrawals out. */
export async function getDailyUsageKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  // Independent sums: issued together, not one after the other.
  const [swept, deposited, withdrawn] = await Promise.all([
    getDailySweptKobo(spaceId, tx),
    getDailyDepositedKobo(spaceId, tx),
    getDailyWithdrawnKobo(spaceId, tx),
  ]);
  return swept + deposited + withdrawn;
}

export async function getDailyAllowanceKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  return Math.max(0, DAILY_LIMIT_KOBO - (await getDailyUsageKobo(spaceId, tx)));
}

/** What the space may still withdraw today: its own ₦5M, within the account's ₦10M. */
export async function getWithdrawalAllowanceKobo(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  // Today's withdrawals feed both limits; read them once (they used to be
  // summed twice, once more inside the account's daily usage).
  const [withdrawn, swept, deposited] = await Promise.all([
    getDailyWithdrawnKobo(spaceId, tx),
    getDailySweptKobo(spaceId, tx),
    getDailyDepositedKobo(spaceId, tx),
  ]);
  const account = Math.max(0, DAILY_LIMIT_KOBO - (swept + deposited + withdrawn));
  return Math.max(0, Math.min(DAILY_PAYOUT_LIMIT_KOBO - withdrawn, account));
}

/**
 * A space's money split by where it sits, for the wallet screen. The balance
 * may be passed still pending, so its query runs alongside these.
 */
export async function getSpaceFunds(spaceId: string, balance: number | Promise<number>) {
  const [unswept, allowance, balanceKobo] = await Promise.all([getUnsweptKobo(spaceId), getWithdrawalAllowanceKobo(spaceId), balance]);
  return {
    inSpaceAccountKobo: Math.max(0, balanceKobo - unswept),
    awaitingSweepKobo: unswept,
    dailyLimitKobo: DAILY_PAYOUT_LIMIT_KOBO,
    dailyRemainingKobo: allowance,
  };
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * Record a sweep inside the caller's transaction, which must hold the space
 * lock. Used by the daily job and by a withdrawal that needs money moved first.
 */
export async function createSweep(tx: Tx, spaceId: string, amountKobo: number, trigger: SweepTrigger): Promise<Sweep> {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) throw new RangeError(`sweep amount must be positive, got ${amountKobo}`);
  const reference = generateSweepReference();
  return tx.sweep.create({
    data: {
      spaceId,
      amountKobo,
      trigger,
      reference,
      providerReference: getPaymentProvider().wireReference(reference),
    },
  });
}

/**
 * Sweep up to `maxKobo` of the space's unswept money, within today's
 * allowance, as transfers of at most MAX_TRANSFER_KOBO each. Empty when
 * there's nothing to move.
 */
export async function startSweep(spaceId: string, trigger: SweepTrigger, maxKobo = Infinity): Promise<Sweep[]> {
  const space = await ensureSpaceAccount(spaceId);
  if (!space.walletAccountNumber) return [];
  const sweeps = await db.$transaction(async (tx) => {
    await lockSpace(tx, spaceId);
    await lockBusinessSweeps(tx);
    const [unswept, allowance, business] = await Promise.all([
      getUnsweptKobo(spaceId, tx),
      getDailyAllowanceKobo(spaceId, tx),
      getBusinessSweepAllowanceKobo(tx),
    ]);
    // Past the business account's limit, the rest waits for tomorrow's run.
    let left = Math.min(unswept, allowance, business, maxKobo);
    const created: Sweep[] = [];
    while (left > 0) {
      const amount = Math.min(left, MAX_TRANSFER_KOBO);
      created.push(await createSweep(tx, spaceId, amount, trigger));
      left -= amount;
    }
    return created;
  });
  for (const sweep of sweeps) await dispatchSweep(sweep.id);
  return sweeps;
}

/** Send a pending sweep. Safe to repeat: 9jaPay refuses a second transfer under the same reference. */
export async function dispatchSweep(sweepId: string): Promise<void> {
  const sweep = await db.sweep.findUnique({ where: { id: sweepId }, include: { space: true } });
  if (!sweep || sweep.status !== 'pending') return;
  const { space } = sweep;
  if (!space.walletAccountNumber || !space.walletBankCode || !space.walletAccountName) {
    logger.warn({ ref: sweep.reference, spaceId: space.id }, 'sweep waiting for the space account');
    return;
  }
  try {
    const result = await getPaymentProvider().initiateTransfer({
      from: 'business',
      bankCode: space.walletBankCode,
      accountNumber: space.walletAccountNumber,
      accountName: space.walletAccountName,
      amountKobo: sweep.amountKobo,
      reference: sweep.reference,
      // "Duevy/<code> sent you NGN<amount>"; the reference travels as the payment reference.
      narration: transferNarration({ spaceCode: space.short, amountKobo: sweep.amountKobo }),
    });
    await db.sweep.updateMany({
      where: { id: sweep.id, status: 'pending' },
      data: { status: 'processing', processingAt: new Date(), providerReference: result.providerReference },
    });
    logger.info({ ref: sweep.reference, spaceId: space.id, amount: sweep.amountKobo, state: result.state }, 'sweep dispatched');
    if (result.state === 'succeeded') await completeSweep(sweep.id);
    if (result.state === 'failed') await failSweep(sweep.id, result.failureReason ?? 'The transfer was refused');
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      await failSweep(sweep.id, err.message);
      return;
    }
    logger.warn({ ref: sweep.reference, err: (err as Error).message }, 'sweep dispatch deferred');
  }
}

/** The sweep landed: send the withdrawals that were waiting for it. Idempotent. */
export async function completeSweep(sweepId: string): Promise<boolean> {
  const { count } = await db.sweep.updateMany({
    where: { id: sweepId, status: { in: ['pending', 'processing'] } },
    data: { status: 'succeeded', settledAt: new Date() },
  });
  if (count === 0) return false;
  logger.info({ sweepId }, 'sweep succeeded');
  await releaseWaitingPayouts(sweepId);
  return true;
}

export async function failSweep(sweepId: string, reason: string): Promise<boolean> {
  const { count } = await db.sweep.updateMany({
    where: { id: sweepId, status: { in: ['pending', 'processing'] } },
    data: { status: 'failed', failedAt: new Date(), failureReason: reason.slice(0, 300) },
  });
  if (count === 0) return false;
  logger.error({ sweepId, reason }, 'sweep failed — the money counts as unswept again');
  await releaseWaitingPayouts(sweepId);
  return true;
}

async function releaseWaitingPayouts(sweepId: string): Promise<void> {
  const waiting = await db.payout.findMany({ where: { sweepId, status: 'pending' }, select: { id: true } });
  for (const p of waiting) {
    await dispatchPayout(p.id).catch((err) => logger.warn({ payoutId: p.id, err: (err as Error).message }, 'payout after sweep deferred'));
  }
}

/** Ask 9jaPay about a sweep and apply the answer. */
export async function refreshSweep(sweepId: string): Promise<void> {
  const sweep = await db.sweep.findUnique({ where: { id: sweepId } });
  if (!sweep || (sweep.status !== 'processing' && sweep.status !== 'pending')) return;
  let result;
  try {
    result = await getPaymentProvider().getTransfer(sweep.reference);
  } catch (err) {
    // Never reached 9jaPay: send it (again). The reference stops a double send.
    if (err instanceof ProviderError && err.code === 'NOT_FOUND') {
      if (sweep.status === 'processing') await db.sweep.update({ where: { id: sweep.id }, data: { status: 'pending' } });
      await dispatchSweep(sweep.id);
      return;
    }
    throw err;
  }
  if (result.state === 'succeeded') await completeSweep(sweep.id);
  else if (result.state === 'failed') await failSweep(sweep.id, result.failureReason ?? 'The transfer was refused');
}

/** A sweep landed in a space's account (its credit event): confirm that space's sweeps in flight. */
export async function refreshSweepsForAccount(accountNumber: string): Promise<void> {
  const space = await db.space.findUnique({ where: { walletAccountNumber: accountNumber }, select: { id: true } });
  if (!space) {
    logger.warn({ accountNumber }, 'credit on an account that is no space’s');
    return;
  }
  const inFlight = await db.sweep.findMany({ where: { spaceId: space.id, status: { in: ['pending', 'processing'] } } });
  for (const s of inFlight) await refreshSweep(s.id);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Once a Lagos day (from DAILY_SWEEP_HOUR_LAGOS), sweep every space holding at
 * least SWEEP_MIN_KOBO unswept, and open any space account that failed to open.
 * Safe to call every reconciliation tick: a space already swept today is skipped.
 */
export async function runDailySweeps(now = new Date()): Promise<void> {
  const dayStart = startOfLagosDay(now);
  if (now.getTime() < dayStart.getTime() + DAILY_SWEEP_HOUR_LAGOS * 60 * 60 * 1000) return;

  const missing = await db.space.findMany({ where: { walletAccountNumber: null, isArchived: false }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 25 });
  for (const s of missing) {
    await ensureSpaceAccount(s.id).catch((err) => logger.warn({ spaceId: s.id, err: (err as Error).message }, 'space account retry failed'));
  }

  const provider = getPaymentProvider().name;
  const candidates = await db.$queryRaw<{ spaceId: string }[]>`
    SELECT le."spaceId"
      FROM "ledger_entries" le
      JOIN "due_payments" dp ON dp."id" = le."duePaymentId"
      JOIN "checkouts" c ON c."id" = dp."checkoutId"
     WHERE le."type" = 'due_payment' AND c."provider" = ${provider}
       AND NOT EXISTS (SELECT 1 FROM "sweeps" s
                        WHERE s."spaceId" = le."spaceId" AND s."trigger" = 'daily' AND s."createdAt" >= ${dayStart})
     GROUP BY le."spaceId"`;
  for (const { spaceId } of candidates) {
    try {
      if ((await getUnsweptKobo(spaceId)) < env.SWEEP_MIN_KOBO) continue;
      await startSweep(spaceId, 'daily');
    } catch (err) {
      logger.warn({ spaceId, err: (err as Error).message }, 'daily sweep failed');
    }
  }
}

const RETRY_DISPATCH_AFTER_MS = 2 * 60 * 1000;
const CHECK_PROCESSING_AFTER_MS = 10 * 60 * 1000;

/** Reconciliation: resend sweeps that never went out, and ask about ones gone quiet. */
export async function reconcileSweeps(): Promise<void> {
  const now = Date.now();
  const stale = await db.sweep.findMany({
    where: {
      OR: [
        { status: 'pending', createdAt: { lte: new Date(now - RETRY_DISPATCH_AFTER_MS) } },
        { status: 'processing', processingAt: { lte: new Date(now - CHECK_PROCESSING_AFTER_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 25,
  });
  for (const s of stale) {
    await (s.status === 'pending' ? dispatchSweep(s.id) : refreshSweep(s.id)).catch((err) =>
      logger.warn({ ref: s.reference, err: (err as Error).message }, 'sweep reconciliation failed'),
    );
  }
}

/** For withdrawal.service: refuse cleanly when a space can't take a withdrawal today. */
export function dailyLimitError(remainingKobo: number): AppError {
  return new AppError(
    422,
    'DAILY_LIMIT_EXCEEDED',
    `A space can withdraw at most ₦${(DAILY_PAYOUT_LIMIT_KOBO / 100).toLocaleString('en-NG')} a day. ₦${(remainingKobo / 100).toLocaleString('en-NG')} is left today.`,
    [{ field: 'amount', issue: `remaining today is ${remainingKobo} kobo` }],
  );
}

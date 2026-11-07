import { type Checkout } from '@prisma/client';
import { db } from '../config/db';
import { logger } from '../lib/logger';
import { getPaymentProvider, type CollectionStatus } from '../providers/payment';
import { expireCheckout, fulfilCheckout, markUnderpaid } from '../services/checkout.service';
import { dispatchPayout, refreshPayout } from '../services/withdrawal.service';
import { reconcileSweeps, runDailySweeps } from '../services/sweep.service';
import { expireStaleApprovals } from '../services/withdrawalApproval.service';
import { retryGuestAccountInvites } from '../services/guestAccount.service';

/**
 * Self-healing backstop for lost or delayed webhooks. The webhook is the fast
 * path; this asks the provider directly about anything that has gone quiet.
 * Every action goes through the same idempotent service functions, so racing a
 * webhook is safe.
 *
 * Only rows created through the CURRENT provider are touched — Anchor-era
 * records are resolved by hand.
 */

// Short: payment events can be slow or missing, and a student is usually
// waiting on the pay page. Checking a pending checkout is one cheap GET.
const CHECK_PENDING_AFTER_MS = 2 * 60 * 1000;
const EXPIRY_GRACE_MS = 5 * 60 * 1000;
const RETRY_DISPATCH_AFTER_MS = 2 * 60 * 1000;
const CHECK_PROCESSING_AFTER_MS = 15 * 60 * 1000;

/**
 * When a payment into a checkout's one-time account can have landed: from
 * when the checkout was created (less some slack, since that's our clock) to
 * when it expired. No slack after expiry: expiresAt is 9jaPay's own, it
 * refuses money after it, and the number can be handed to the next checkout
 * straight away, whose payment must not count for this one.
 */
const PAYMENT_WINDOW_SLACK_MS = 2 * 60 * 1000;
function paymentWindow(c: Pick<Checkout, 'createdAt' | 'expiresAt'>) {
  return { from: new Date(c.createdAt.getTime() - PAYMENT_WINDOW_SLACK_MS), to: c.expiresAt };
}

type ReconcilableCheckout = Pick<Checkout, 'id' | 'reference' | 'status' | 'vaAccountNumber' | 'totalKobo' | 'createdAt' | 'expiresAt'>;

/**
 * What the provider says arrived for this checkout, minus any credit another
 * checkout has already claimed (reused account numbers). With individual
 * credits, the earliest unclaimed one is this checkout's payment.
 */
async function collectionFor(c: ReconcilableCheckout & { vaAccountNumber: string }): Promise<CollectionStatus & { transactionId: string | null }> {
  const status = await getPaymentProvider().getCollectionStatus(c.vaAccountNumber, paymentWindow(c));
  if (!status.credits) return { ...status, transactionId: null };
  const ids = status.credits.map((cr) => cr.transactionId);
  const claimed = new Set(
    ids.length
      ? (await db.checkout.findMany({ where: { providerTransactionId: { in: ids }, id: { not: c.id } }, select: { providerTransactionId: true } }))
          .map((r) => r.providerTransactionId)
      : [],
  );
  const credit = status.credits.find((cr) => !claimed.has(cr.transactionId));
  if (!credit) return { state: 'open', receivedKobo: null, transactionId: null };
  return { state: 'paid', receivedKobo: credit.amountKobo, transactionId: credit.transactionId };
}

export async function reconcileCheckouts(): Promise<void> {
  const provider = getPaymentProvider();
  const now = Date.now();
  const pending = await db.checkout.findMany({
    where: { provider: provider.name, status: 'pending', createdAt: { lte: new Date(now - CHECK_PENDING_AFTER_MS) } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  for (const c of pending) {
    try {
      await reconcileCheckout(c, { expireIfPastDue: true, source: 'reconciliation' });
    } catch (err) {
      logger.warn({ ref: c.reference, err: (err as Error).message }, 'checkout reconciliation failed');
    }
  }
}

/**
 * Ask the provider about one pending checkout and apply what it says. Used by
 * the job above and by the student's pay page (GET /payments/:ref/status), so
 * a student back from the checkout page sees "paid" without waiting for the
 * webhook. Only the provider's answer moves the checkout, never the caller.
 */
export async function reconcileCheckout(
  c: ReconcilableCheckout,
  opts: { expireIfPastDue: boolean; source: string },
): Promise<void> {
  if (c.status !== 'pending') return;
  const pastExpiry = c.expiresAt.getTime() + EXPIRY_GRACE_MS < Date.now();
  if (!c.vaAccountNumber) {
    // The account was never opened; nothing can be paid into it.
    if (opts.expireIfPastDue && pastExpiry) await expireCheckout(c.id, 'no collection account was opened');
    return;
  }
  const status = await collectionFor({ ...c, vaAccountNumber: c.vaAccountNumber });
  if (status.state === 'paid') {
    // Never assume our own expected total arrived: an unknown amount could hide
    // an underpayment. Leave it for the webhook or the next sweep.
    if (status.receivedKobo === null) {
      logger.warn({ ref: c.reference, source: opts.source }, 'provider reports paid without a received amount; not fulfilling');
      return;
    }
    await fulfilCheckout(c.id, status.receivedKobo, 0, opts.source, null, status.transactionId);
  }
  else if (status.state === 'underpaid') await markUnderpaid(c.id, status.receivedKobo ?? 0, c.totalKobo, opts.source);
  else if (status.state === 'expired' || status.state === 'failed') await expireCheckout(c.id);
  else if (opts.expireIfPastDue && pastExpiry) await expireCheckout(c.id);
}

/**
 * A payment event for a checkout in ANY state: read what arrived from the
 * provider and apply it. Unlike reconcileCheckout this also honours money that
 * lands after the checkout expired or was underpaid (fulfilCheckout flags it);
 * a paid checkout is a no-op there.
 */
export async function confirmReceivedPayment(c: ReconcilableCheckout, source: string): Promise<void> {
  if (c.status === 'paid' || !c.vaAccountNumber) return;
  const status = await collectionFor({ ...c, vaAccountNumber: c.vaAccountNumber });
  if (status.state !== 'paid' || status.receivedKobo === null) {
    logger.warn({ ref: c.reference, source, state: status.state }, 'payment event without a matching credit at the provider; nothing applied');
    return;
  }
  await fulfilCheckout(c.id, status.receivedKobo, 0, source, null, status.transactionId);
}

export async function reconcilePayouts(): Promise<void> {
  const provider = getPaymentProvider();
  const now = Date.now();

  // Created but never accepted by the provider (crash, timeout): resend. The
  // reference is the idempotency key, so this cannot pay twice.
  const undispatched = await db.payout.findMany({
    where: { provider: provider.name, status: 'pending', requestedAt: { lte: new Date(now - RETRY_DISPATCH_AFTER_MS) } },
    take: 25,
  });
  for (const p of undispatched) {
    await dispatchPayout(p.id).catch((err) => logger.warn({ ref: p.reference, err: (err as Error).message }, 'payout retry failed'));
  }

  const processing = await db.payout.findMany({
    where: { provider: provider.name, status: 'processing', processingAt: { lte: new Date(now - CHECK_PROCESSING_AFTER_MS) } },
    take: 25,
  });
  for (const p of processing) {
    await refreshPayout(p.id).catch((err) => logger.warn({ ref: p.reference, err: (err as Error).message }, 'payout refresh failed'));
  }

  // Multisig withdrawals nobody approved in time: cancel and restore the balance.
  await expireStaleApprovals();
}

/** Housekeeping: drop idempotency keys past their 24h window. */
export async function purgeExpiredIdempotencyKeys(): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

const PURGE_BATCH = 5_000;
const PURGE_MAX_BATCHES = 20;
// Expired refresh tokens are refused by their own JWT expiry, so a row past
// it is dead weight; the margin only keeps recent ones around for support.
const REFRESH_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastAuthPurgeAt = 0;

/**
 * Housekeeping: delete expired refresh tokens, email verifications and
 * password resets, which otherwise grow with every sign-in forever. In
 * bounded batches (id lookup, then delete by id) so a first run over a large
 * backlog never becomes one long-running DELETE. Hourly, not every pass.
 */
export async function purgeExpiredAuthTokens(now = Date.now()): Promise<number> {
  if (now - lastAuthPurgeAt < AUTH_PURGE_INTERVAL_MS) return 0;
  lastAuthPurgeAt = now;
  let purged = 0;
  const tables = [
    { find: (take: number) => db.refreshToken.findMany({ where: { expiresAt: { lt: new Date(now - REFRESH_TOKEN_RETENTION_MS) } }, select: { id: true }, take }),
      del: (ids: string[]) => db.refreshToken.deleteMany({ where: { id: { in: ids } } }) },
    { find: (take: number) => db.emailVerification.findMany({ where: { expiresAt: { lt: new Date(now) } }, select: { id: true }, take }),
      del: (ids: string[]) => db.emailVerification.deleteMany({ where: { id: { in: ids } } }) },
    { find: (take: number) => db.passwordReset.findMany({ where: { expiresAt: { lt: new Date(now) } }, select: { id: true }, take }),
      del: (ids: string[]) => db.passwordReset.deleteMany({ where: { id: { in: ids } } }) },
  ];
  for (const t of tables) {
    for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
      const ids = (await t.find(PURGE_BATCH)).map((r) => r.id);
      if (ids.length === 0) break;
      purged += (await t.del(ids)).count;
      if (ids.length < PURGE_BATCH) break;
    }
  }
  if (purged) logger.info({ purged }, 'expired auth tokens purged');
  return purged;
}

/** Reset the hourly gate (tests). */
export function resetAuthPurgeClock(): void {
  lastAuthPurgeAt = 0;
}

/**
 * No cross-instance lock on purpose: a session advisory lock is unreliable
 * behind a transaction pooler (Supabase), and every action here is idempotent
 * and row-locked, so two instances overlapping only costs duplicate reads.
 */
export async function runReconciliationOnce(): Promise<void> {
  await reconcileCheckouts().catch((err) => logger.error({ err: (err as Error).message }, 'checkout reconciliation run failed'));
  await reconcilePayouts().catch((err) => logger.error({ err: (err as Error).message }, 'payout reconciliation run failed'));
  await reconcileSweeps().catch((err) => logger.error({ err: (err as Error).message }, 'sweep reconciliation run failed'));
  await runDailySweeps().catch((err) => logger.error({ err: (err as Error).message }, 'daily sweep run failed'));
  await retryGuestAccountInvites().catch((err) => logger.error({ err: (err as Error).message }, 'guest account invite sweep failed'));
  await purgeExpiredIdempotencyKeys().catch(() => {});
  await purgeExpiredAuthTokens().catch((err) => logger.warn({ err: (err as Error).message }, 'auth token purge failed'));
}

let running: Promise<void> | null = null;

/** Start the periodic sweep. Returns a handle for shutdown. */
export function startReconciliationJob(intervalMs = 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    if (running) return; // never overlap within one process
    running = runReconciliationOnce()
      .catch((err) => logger.error({ err: (err as Error).message }, 'reconciliation failed'))
      .finally(() => {
        running = null;
      });
  }, intervalMs);
}

/** Shutdown: resolves once the pass in flight (if any) has finished. */
export async function reconciliationIdle(): Promise<void> {
  await running;
}

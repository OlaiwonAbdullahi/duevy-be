import { db } from '../config/db';
import { logger } from '../lib/logger';
import { getPaymentProvider } from '../providers/payment';
import { expireCheckout, fulfilCheckout, markUnderpaid } from '../services/checkout.service';
import { dispatchPayout, refreshPayout, settleWithdrawalFee } from '../services/withdrawal.service';

/**
 * Self-healing backstop for lost or delayed webhooks. The webhook is the fast
 * path; this asks the provider directly about anything that has gone quiet.
 * Every action goes through the same idempotent service functions, so racing a
 * webhook is safe.
 *
 * Only rows created through the CURRENT provider are touched — Anchor-era
 * records are resolved by hand.
 */

const CHECK_PENDING_AFTER_MS = 10 * 60 * 1000;
const EXPIRY_GRACE_MS = 5 * 60 * 1000;
const RETRY_DISPATCH_AFTER_MS = 2 * 60 * 1000;
const CHECK_PROCESSING_AFTER_MS = 15 * 60 * 1000;

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
      const pastExpiry = c.expiresAt.getTime() + EXPIRY_GRACE_MS < now;
      if (!c.providerCheckoutId) {
        // The account was never opened; nothing can be paid into it.
        if (pastExpiry) await expireCheckout(c.id, 'no collection account was opened');
        continue;
      }
      const status = await provider.getCollectionStatus(c.providerCheckoutId);
      if (status.state === 'paid') await fulfilCheckout(c.id, status.receivedKobo ?? c.totalKobo, 0, 'reconciliation');
      else if (status.state === 'underpaid') await markUnderpaid(c.id, status.receivedKobo ?? 0, c.totalKobo, 'reconciliation');
      else if (status.state === 'expired' || status.state === 'failed') await expireCheckout(c.id);
      else if (pastExpiry) await expireCheckout(c.id);
    } catch (err) {
      logger.warn({ ref: c.reference, err: (err as Error).message }, 'checkout reconciliation failed');
    }
  }
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

  const unsettledFees = await db.payout.findMany({
    where: { provider: provider.name, status: 'success', feeSettledAt: null },
    take: 25,
  });
  for (const p of unsettledFees) {
    await settleWithdrawalFee(p.id).catch((err) => logger.warn({ ref: p.reference, err: (err as Error).message }, 'fee settlement retry failed'));
  }
}

/** Housekeeping: drop idempotency keys past their 24h window. */
export async function purgeExpiredIdempotencyKeys(): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

/**
 * No cross-instance lock on purpose: a session advisory lock is unreliable
 * behind a transaction pooler (Supabase), and every action here is idempotent
 * and row-locked, so two instances overlapping only costs duplicate reads.
 */
export async function runReconciliationOnce(): Promise<void> {
  await reconcileCheckouts().catch((err) => logger.error({ err: (err as Error).message }, 'checkout reconciliation run failed'));
  await reconcilePayouts().catch((err) => logger.error({ err: (err as Error).message }, 'payout reconciliation run failed'));
  await purgeExpiredIdempotencyKeys().catch(() => {});
}

let running = false;

/** Start the periodic sweep. Returns a handle for shutdown. */
export function startReconciliationJob(intervalMs = 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    if (running) return; // never overlap within one process
    running = true;
    runReconciliationOnce()
      .catch((err) => logger.error({ err: (err as Error).message }, 'reconciliation failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

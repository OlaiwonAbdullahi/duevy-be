import { db } from '../config/db';
import { getTransactionStatus } from '../lib/monnify';
import { fulfilByReference } from '../services/payment.service';
import { reconcileStalePayouts } from '../services/payout.service';

const STALE_AFTER_MS = 15 * 60 * 1000; // §15.1 — check with the provider after 15 minutes
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000; // stop polling an unresolvable reference after 48h

/**
 * Resolve hosted-checkout payments (top-ups, due payments, paid votes) whose
 * webhook never arrived. Runs alongside the webhook, not instead of it — the
 * webhook is the fast path, this is the self-healing fallback (§15.1, §6.4).
 */
export async function reconcilePendingPayments(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
  const giveUpThreshold = new Date(Date.now() - GIVE_UP_AFTER_MS);

  const pending = await db.pendingPayment.findMany({
    where: { status: 'pending', createdAt: { lte: staleThreshold } },
    take: 50,
  });

  for (const p of pending) {
    try {
      const status = await getTransactionStatus(p.reference);
      if (!status) {
        if (p.createdAt <= giveUpThreshold) {
          await fulfilByReference(p.reference, false);
        }
        continue;
      }
      if (status.paymentStatus === 'PAID') {
        await fulfilByReference(p.reference, true);
      } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(status.paymentStatus)) {
        await fulfilByReference(p.reference, false);
      }
      // Still pending upstream — leave it for the next tick.
    } catch (err) {
      console.error(`[reconciliation] failed to check payment ${p.reference}:`, err);
    }
  }
}

async function runOnce(): Promise<void> {
  await reconcilePendingPayments().catch((err) => console.error('[reconciliation] pending payments run failed:', err));
  await reconcileStalePayouts().catch((err) => console.error('[reconciliation] payouts run failed:', err));
}

/** Start the periodic reconciliation sweep. Returns a handle for shutdown. */
export function startReconciliationJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    runOnce().catch((err) => console.error('[reconciliation] run failed:', err));
  }, intervalMs);
}

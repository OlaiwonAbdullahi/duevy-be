import { db } from '../config/db';
import { getPayWithTransfer } from '../lib/anchor';
import { checkoutIdFor, fulfilByReference } from '../services/payment.service';
import { reconcileStalePayouts, remitToSpaces } from '../services/payout.service';

const STALE_AFTER_MS = 15 * 60 * 1000; // §15.1 — check with the provider after 15 minutes
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000; // stop chasing an unresolvable reference after 48h

/**
 * Resolve payments whose payin.received webhook never arrived. Runs alongside
 * the webhook, not instead of it — the webhook is the fast path, this is the
 * self-healing fallback (§15.1, §6.4).
 *
 * Anchor has no checkout session to poll, but a Pay With Transfer gains a
 * `payIn` relationship once it has been funded, so reading the checkout back
 * tells us whether the money arrived and only the notification was lost. That
 * is one call per stale payment; unlike the old account-scan there is nothing
 * to batch, because each checkout is its own object.
 */
export async function reconcilePendingPayments(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
  const giveUpThreshold = new Date(Date.now() - GIVE_UP_AFTER_MS);

  const pending = await db.pendingPayment.findMany({
    where: { status: 'pending', createdAt: { lte: staleThreshold } },
    take: 50,
  });

  for (const p of pending) {
    const checkoutId = checkoutIdFor(p.metadata);
    if (!checkoutId) {
      // The checkout was never opened against Anchor — nothing can resolve it.
      if (p.createdAt <= giveUpThreshold) await fulfilByReference(p.reference, false);
      continue;
    }

    try {
      const checkout = await getPayWithTransfer(checkoutId);
      if (checkout?.funded) {
        await fulfilByReference(p.reference, true);
        continue;
      }
      // Anchor enforces the expiry, so once the window has closed and nothing
      // arrived, no late transfer can change that.
      if (p.expiresAt <= new Date() && p.createdAt <= giveUpThreshold) {
        await fulfilByReference(p.reference, false);
      }
    } catch (err) {
      console.error(`[reconciliation] failed to check checkout ${checkoutId}:`, err);
    }
  }
}

async function runOnce(): Promise<void> {
  await reconcilePendingPayments().catch((err) => console.error('[reconciliation] pending payments run failed:', err));
  await remitToSpaces().catch((err) => console.error('[reconciliation] remittance run failed:', err));
  await reconcileStalePayouts().catch((err) => console.error('[reconciliation] payouts run failed:', err));
}

/** Start the periodic reconciliation sweep. Returns a handle for shutdown. */
export function startReconciliationJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    runOnce().catch((err) => console.error('[reconciliation] run failed:', err));
  }, intervalMs);
}

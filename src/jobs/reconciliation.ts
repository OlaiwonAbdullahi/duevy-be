import { db } from '../config/db';
import { listAccountTransactions } from '../lib/anchor';
import { fulfilByReference } from '../services/payment.service';
import { reconcileStalePayouts, sweepServiceCharges } from '../services/payout.service';

const STALE_AFTER_MS = 15 * 60 * 1000; // §15.1 — check with the provider after 15 minutes
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000; // stop chasing an unresolvable reference after 48h

/** Which Anchor account a pending checkout was settling into. */
async function settlementAccountFor(metadata: unknown): Promise<string | null> {
  const meta = (metadata ?? {}) as { dueId?: string; pollId?: string };

  if (meta.dueId) {
    const due = await db.due.findUnique({
      where: { id: meta.dueId },
      select: { space: { select: { anchorAccountId: true } } },
    });
    return due?.space.anchorAccountId ?? null;
  }
  if (meta.pollId) {
    const poll = await db.poll.findUnique({
      where: { id: meta.pollId },
      select: { space: { select: { anchorAccountId: true } } },
    });
    return poll?.space.anchorAccountId ?? null;
  }
  return null;
}

/**
 * Resolve payments whose payment.received webhook never arrived. Runs alongside
 * the webhook, not instead of it — the webhook is the fast path, this is the
 * self-healing fallback (§15.1, §6.4).
 *
 * Anchor has no checkout session to poll, so the check is against the
 * settlement account's own transaction history: a credit carrying our reference
 * means the money arrived and only the notification was lost.
 */
export async function reconcilePendingPayments(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
  const giveUpThreshold = new Date(Date.now() - GIVE_UP_AFTER_MS);

  const pending = await db.pendingPayment.findMany({
    where: { status: 'pending', createdAt: { lte: staleThreshold } },
    take: 50,
  });

  // One transaction listing per account, not per payment — a busy space can
  // easily have several stale checkouts in the same tick.
  const byAccount = new Map<string, typeof pending>();
  for (const p of pending) {
    const accountId = await settlementAccountFor(p.metadata);
    if (!accountId) {
      // Never provisioned, or the due was deleted — nothing can ever resolve it.
      if (p.createdAt <= giveUpThreshold) await fulfilByReference(p.reference, false);
      continue;
    }
    const bucket = byAccount.get(accountId) ?? [];
    bucket.push(p);
    byAccount.set(accountId, bucket);
  }

  for (const [accountId, payments] of byAccount) {
    try {
      const credits = await listAccountTransactions(accountId, { limit: 100 });
      const creditByRef = new Map(
        credits.filter((t) => t.direction === 'CREDIT' && t.reference).map((t) => [t.reference as string, t]),
      );

      for (const p of payments) {
        const credit = creditByRef.get(p.reference);
        if (credit) {
          await fulfilByReference(p.reference, true, { creditedKobo: credit.amountKobo });
          continue;
        }
        // The virtual account is long expired and no credit ever landed.
        if (p.expiresAt <= new Date() && p.createdAt <= giveUpThreshold) {
          await fulfilByReference(p.reference, false);
        }
      }
    } catch (err) {
      console.error(`[reconciliation] failed to check account ${accountId}:`, err);
    }
  }
}

async function runOnce(): Promise<void> {
  await reconcilePendingPayments().catch((err) => console.error('[reconciliation] pending payments run failed:', err));
  await sweepServiceCharges().catch((err) => console.error('[reconciliation] service-charge sweep failed:', err));
  await reconcileStalePayouts().catch((err) => console.error('[reconciliation] payouts run failed:', err));
}

/** Start the periodic reconciliation sweep. Returns a handle for shutdown. */
export function startReconciliationJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    runOnce().catch((err) => console.error('[reconciliation] run failed:', err));
  }, intervalMs);
}

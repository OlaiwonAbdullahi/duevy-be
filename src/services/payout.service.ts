import { type Payout } from '@prisma/client';
import { db } from '../config/db';
import { decrypt } from '../lib/encryption';
import { initiateDisbursement, getDisbursementStatus, isDisbursementConfigured } from '../lib/paymentGateway';
import { notifyMany } from '../lib/notifications';

const STALE_PAYOUT_AFTER_MS = 15 * 60 * 1000;

/**
 * Kick off the actual bank transfer for a freshly-created payout (§10.3).
 * Best-effort: if disbursement isn't configured or the provider call fails,
 * the payout simply stays `processing` for the reconciliation job to retry.
 */
export async function initiatePayoutDisbursement(payout: Payout): Promise<void> {
  if (!isDisbursementConfigured()) return;

  const account = await db.bankAccount.findUnique({ where: { spaceId: payout.spaceId } });
  if (!account) return;

  try {
    const result = await initiateDisbursement({
      amount: payout.amount,
      reference: payout.reference,
      narration: `Duevy payout ${payout.reference}`,
      bankCode: account.bankCode,
      accountNumber: decrypt(account.accountNumber),
      accountName: account.accountName,
    });
    if (result.status === 'SUCCESS') {
      await settlePayout(payout.reference, true);
    } else if (result.status === 'FAILED') {
      await settlePayout(payout.reference, false, 'Disbursement was rejected by the payment provider');
    }
    // PENDING — leave `processing`; the webhook or reconciliation job resolves it.
  } catch (err) {
    console.error(`[payout] disbursement init failed for ${payout.reference}:`, err);
  }
}

/** Resolve a `processing` payout to `completed`/`failed`. Idempotent. */
export async function settlePayout(reference: string, success: boolean, failureReason?: string): Promise<void> {
  const payout = await db.payout.findUnique({ where: { reference } });
  if (!payout || payout.status !== 'processing') return;

  const updated = await db.payout.update({
    where: { reference },
    data: success
      ? { status: 'completed', settledAt: new Date() }
      : { status: 'failed', failureReason: failureReason ?? 'The payout could not be completed' },
  });

  const reps = await db.spaceRep.findMany({ where: { spaceId: updated.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    success
      ? {
          kind: 'payout_completed',
          title: 'Payout completed',
          detail: `₦${(updated.amount / 100).toLocaleString('en-NG')} was sent to ${updated.accountMasked}.`,
          href: '/dashboard/payout',
        }
      : {
          kind: 'system',
          tone: 'rose',
          title: 'Payout failed',
          detail: `Your ₦${(updated.amount / 100).toLocaleString('en-NG')} payout could not be completed.`,
          href: '/dashboard/payout',
        },
  );
}

/** Poll the provider for payouts that have sat in `processing` too long (reconciliation job). */
export async function reconcileStalePayouts(): Promise<void> {
  if (!isDisbursementConfigured()) return;

  const staleThreshold = new Date(Date.now() - STALE_PAYOUT_AFTER_MS);
  const stale = await db.payout.findMany({
    where: { status: 'processing', requestedAt: { lte: staleThreshold } },
    take: 50,
  });

  for (const payout of stale) {
    try {
      const status = await getDisbursementStatus(payout.reference);
      if (!status) continue;
      if (status.status === 'SUCCESS') await settlePayout(payout.reference, true);
      else if (status.status === 'FAILED') await settlePayout(payout.reference, false);
    } catch (err) {
      console.error(`[payout] reconciliation failed for ${payout.reference}:`, err);
    }
  }
}

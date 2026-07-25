import { type Payout, type PayoutApprovalDecision, type RepRole } from '@prisma/client';
import { db } from '../config/db';
import { writeAudit } from '../lib/audit';
import { initiatePayoutDisbursement } from './payout.service';

/** Fraction of a space's total reps (all SpaceRep rows) required to approve a payout. */
export const PAYOUT_APPROVAL_THRESHOLD_FRACTION = 0.7;

/** Rounds up — "70% approval" means at least 70%, never just under. */
export function requiredApprovalCount(totalReps: number): number {
  return Math.max(1, Math.ceil(totalReps * PAYOUT_APPROVAL_THRESHOLD_FRACTION));
}

export type ApprovalStatus = {
  totalReps: number;
  approvedCount: number;
  requiredCount: number;
  met: boolean;
};

export async function getApprovalStatus(payoutId: string, spaceId: string): Promise<ApprovalStatus> {
  const [totalReps, approvedCount] = await Promise.all([
    db.spaceRep.count({ where: { spaceId } }),
    db.payoutApproval.count({ where: { payoutId, decision: 'approved' } }),
  ]);
  const requiredCount = requiredApprovalCount(totalReps);
  return { totalReps, approvedCount, requiredCount, met: approvedCount >= requiredCount };
}

/**
 * Upsert a rep's vote (they can change their mind — later calls overwrite
 * the earlier decision), then — if the 70% threshold is now met — atomically
 * flip pending_approval -> processing exactly once and kick off the existing,
 * unchanged disbursement pipeline.
 *
 * The atomic `updateMany` + count-check guards against two reps casting the
 * final needed vote concurrently: both could observe `met === true` before
 * either commits, but only the one whose `updateMany` actually matches a
 * still-`pending_approval` row proceeds to call `initiatePayoutDisbursement`.
 * This must not be simplified to a read-then-write — that would allow a real
 * double-disbursement under concurrent votes.
 */
export async function castPayoutApproval(
  payoutId: string,
  actorInfo: { id: string; name: string; role: RepRole | null },
  decision: PayoutApprovalDecision,
): Promise<{ payout: Payout; status: ApprovalStatus }> {
  const payout = await db.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new Error('payout not found');

  if (payout.status !== 'pending_approval') {
    return { payout, status: await getApprovalStatus(payoutId, payout.spaceId) };
  }

  await db.payoutApproval.upsert({
    where: { payoutId_repUserId: { payoutId, repUserId: actorInfo.id } },
    update: { decision, decidedAt: new Date() },
    create: { payoutId, repUserId: actorInfo.id, decision },
  });

  const status = await getApprovalStatus(payoutId, payout.spaceId);
  if (!status.met) {
    return { payout, status };
  }

  const advanced = await db.payout.updateMany({
    where: { id: payoutId, status: 'pending_approval' },
    data: { status: 'processing' },
  });
  const fresh = (await db.payout.findUnique({ where: { id: payoutId } }))!;
  if (advanced.count === 0) {
    // Another concurrent vote already crossed the threshold and advanced it.
    return { payout: fresh, status };
  }

  await writeAudit(
    payout.spaceId,
    actorInfo,
    'payout_disbursement_started',
    `Payout ${payout.reference} reached the approval threshold and moved to processing`,
  );
  await initiatePayoutDisbursement(fresh).catch((err) => console.error('[payout] init failed:', err));
  const settled = (await db.payout.findUnique({ where: { id: payoutId } }))!;
  return { payout: settled, status };
}

import { randomInt } from 'crypto';
import { Prisma, type Payout } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { db } from '../config/db';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { writeAudit } from '../lib/audit';
import { notifyMany } from '../lib/notifications';
import { sendWithdrawalOtpEmail } from '../lib/email';
import { assertPayoutTransition } from '../lib/stateMachine';
import { cancelPayout, dispatchPayout, lockPayout } from './withdrawal.service';
import { getSignatoryIds } from './signatory.service';

/**
 * Multisig withdrawals: a withdrawal waits in `awaiting_approval` (its funds
 * already reserved) until 2 of the space's 3 signatories approve it. Each
 * signatory asks Duevy for a one-time code, which is emailed to them with the
 * withdrawal's details, and approves by entering it. The requester counts as
 * one signature when they are a signatory; a co-rep who isn't needs two.
 * Any signatory can reject it and the requester can withdraw it; either
 * cancels it and restores the balance, as does the approval window running out.
 */

export const REQUIRED_APPROVALS = 2;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = 60 * 1000;

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG')}`;

/** A withdrawal this user may sign now: still waiting, in time, and they are an unsigned signatory. */
async function loadForSigning(payoutId: string, spaceId: string, userId: string) {
  const payout = await db.payout.findUnique({ where: { id: payoutId } });
  if (!payout || payout.spaceId !== spaceId) throw notFound('Withdrawal not found');
  if (payout.status !== 'awaiting_approval') throw conflict('NOT_AWAITING_APPROVAL', 'This withdrawal is no longer waiting for approval');
  if (payout.approvalExpiresAt && payout.approvalExpiresAt <= new Date()) {
    await cancelPayout(payout.id, 'not approved in time');
    throw conflict('APPROVAL_EXPIRED', 'This withdrawal was not approved in time and has been cancelled');
  }
  const signatories = await getSignatoryIds(spaceId);
  if (!signatories.includes(userId)) throw forbidden("Only this space's signatories can approve withdrawals", 'NOT_A_SIGNATORY');
  const signed = await db.payoutApproval.findUnique({ where: { payoutId_repUserId: { payoutId, repUserId: userId } } });
  if (signed) throw conflict('ALREADY_SIGNED', 'You have already signed this withdrawal');
  return { payout, signatories };
}

/** Email a signatory a fresh 6-digit code for this withdrawal. */
export async function sendApprovalOtp(payoutId: string, spaceId: string, userId: string): Promise<{ expiresAt: Date }> {
  const { payout } = await loadForSigning(payoutId, spaceId, userId);
  const existing = await db.payoutOtp.findUnique({ where: { payoutId_userId: { payoutId, userId } } });
  if (existing && existing.createdAt.getTime() > Date.now() - OTP_RESEND_MS) {
    throw new AppError(429, 'OTP_RECENTLY_SENT', 'A code was just sent. Check your email, or try again in a minute.');
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const data = { codeHash: await bcrypt.hash(code, 10), attempts: 0, expiresAt, createdAt: new Date() };
  await db.payoutOtp.upsert({ where: { payoutId_userId: { payoutId, userId } }, update: data, create: { payoutId, userId, ...data } });

  const [signer, space, due, requester] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } }),
    db.space.findUniqueOrThrow({ where: { id: spaceId }, select: { name: true } }),
    payout.dueId ? db.due.findUnique({ where: { id: payout.dueId }, select: { title: true } }) : null,
    payout.requestedById ? db.user.findUnique({ where: { id: payout.requestedById }, select: { name: true } }) : null,
  ]);
  await sendWithdrawalOtpEmail(signer.email, signer.name, {
    code,
    spaceName: space.name,
    amountKobo: payout.amount,
    destination: [payout.accountName, payout.accountMasked].filter(Boolean).join(', '),
    dueTitle: due?.title ?? null,
    requestedBy: requester?.name ?? 'A rep',
    reference: payout.reference,
    expiresInMinutes: OTP_TTL_MS / 60_000,
  });
  return { expiresAt };
}

/** Check a code. Wrong guesses are counted atomically; the fifth voids it. */
async function checkOtp(payoutId: string, userId: string, otp: string): Promise<void> {
  const row = await db.payoutOtp.findUnique({ where: { payoutId_userId: { payoutId, userId } } });
  if (!row || row.expiresAt <= new Date()) {
    throw new AppError(400, 'OTP_EXPIRED', 'That code has expired. Request a new one.', [{ field: 'otp', issue: 'expired' }]);
  }
  if (await bcrypt.compare(otp, row.codeHash)) return;
  const { attempts } = await db.payoutOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } }, select: { attempts: true } });
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await db.payoutOtp.deleteMany({ where: { id: row.id } });
    logger.warn({ payoutId, userId }, 'withdrawal approval code voided after repeated failures');
    throw new AppError(423, 'OTP_LOCKED', 'Too many wrong codes. Request a new one.');
  }
  throw new AppError(403, 'INVALID_OTP', 'The code is incorrect', [{ field: 'otp', issue: `incorrect; ${OTP_MAX_ATTEMPTS - attempts} attempt(s) left` }]);
}

/**
 * A signatory approves with their code. The second approval releases the
 * withdrawal to the bank.
 */
export async function approvePayout(
  payoutId: string,
  spaceId: string,
  userId: string,
  otp: string,
): Promise<{ payout: Payout; approvals: number; required: number }> {
  const { signatories } = await loadForSigning(payoutId, spaceId, userId);
  await checkOtp(payoutId, userId, otp);
  const signer = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  const role = (await db.spaceRep.findUnique({ where: { userId_spaceId: { userId, spaceId } }, select: { role: true } }))?.role ?? null;

  let result: { payout: Payout; approvals: number };
  try {
    result = await db.$transaction(async (tx) => {
      const p = await lockPayout(tx, payoutId);
      if (p.status !== 'awaiting_approval') throw conflict('NOT_AWAITING_APPROVAL', 'This withdrawal is no longer waiting for approval');
      await tx.payoutApproval.create({ data: { payoutId, repUserId: userId, decision: 'approved' } });
      await tx.payoutOtp.deleteMany({ where: { payoutId, userId } });
      // Only current signatories count: a signature from someone since replaced doesn't.
      const approvals = await tx.payoutApproval.count({ where: { payoutId, decision: 'approved', repUserId: { in: signatories } } });
      let payout = p;
      if (approvals >= REQUIRED_APPROVALS) {
        assertPayoutTransition('awaiting_approval', 'pending');
        payout = await tx.payout.update({ where: { id: p.id }, data: { status: 'pending', approvalExpiresAt: null } });
      }
      await writeAudit(
        spaceId,
        { id: userId, name: signer.name, role },
        'payout_approval_cast',
        `Approved the ${naira(p.amount)} withdrawal ${p.reference} (${Math.min(approvals, REQUIRED_APPROVALS)} of ${REQUIRED_APPROVALS})`,
        tx,
      );
      return { payout, approvals };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('ALREADY_SIGNED', 'You have already signed this withdrawal');
    throw err;
  }

  if (result.payout.status === 'pending') {
    logger.info({ ref: result.payout.reference }, 'withdrawal approved by signatories');
    await dispatchPayout(result.payout.id);
    result.payout = await db.payout.findUniqueOrThrow({ where: { id: result.payout.id } });
  } else {
    // One signature in: tell the other signatories it's waiting on them.
    const waiting = signatories.filter((id) => id !== userId);
    await notifyMany(waiting, {
      kind: 'system',
      title: 'Withdrawal needs one more approval',
      detail: `${signer.name} approved the ${naira(result.payout.amount)} withdrawal to ${result.payout.accountName ?? result.payout.accountMasked}. One more signatory needs to approve it.`,
      href: '/dashboard/payout',
    }).catch(() => {});
  }
  return { payout: result.payout, approvals: result.approvals, required: REQUIRED_APPROVALS };
}

/** A signatory rejects a waiting withdrawal, or its requester withdraws it. No code needed: it only stops money. */
export async function rejectPayout(payoutId: string, spaceId: string, userId: string, reason?: string): Promise<Payout> {
  const payout = await db.payout.findUnique({ where: { id: payoutId } });
  if (!payout || payout.spaceId !== spaceId) throw notFound('Withdrawal not found');
  if (payout.status !== 'awaiting_approval') throw conflict('NOT_AWAITING_APPROVAL', 'This withdrawal is no longer waiting for approval');

  const signatories = await getSignatoryIds(spaceId);
  const isSignatory = signatories.includes(userId);
  const isRequester = payout.requestedById === userId;
  if (!isSignatory && !isRequester) throw forbidden("Only this space's signatories can reject withdrawals", 'NOT_A_SIGNATORY');

  const [actor, rep] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } }),
    db.spaceRep.findUnique({ where: { userId_spaceId: { userId, spaceId } }, select: { role: true } }),
  ]);
  const why = isRequester && !isSignatory ? `withdrawn by ${actor.name}` : `rejected by ${actor.name}${reason ? ` — ${reason}` : ''}`;
  if (isSignatory) {
    await db.payoutApproval
      .upsert({
        where: { payoutId_repUserId: { payoutId, repUserId: userId } },
        update: { decision: 'rejected', decidedAt: new Date() },
        create: { payoutId, repUserId: userId, decision: 'rejected' },
      })
      .catch(() => {});
  }
  const cancelled = await cancelPayout(payoutId, why);
  if (!cancelled) throw conflict('NOT_AWAITING_APPROVAL', 'This withdrawal is no longer waiting for approval');
  await writeAudit(spaceId, { id: userId, name: actor.name, role: rep?.role ?? null }, 'payout_cancelled', `Cancelled the ${naira(payout.amount)} withdrawal ${payout.reference}: ${why}`);
  return cancelled;
}

/**
 * Right after a multisig withdrawal is created: tell the other signatories,
 * and send the requester their own code when they are a signatory.
 */
export async function announceForApproval(payout: Payout, requesterId: string): Promise<{ otpSentToRequester: boolean }> {
  const [signatories, requester] = await Promise.all([
    getSignatoryIds(payout.spaceId),
    db.user.findUnique({ where: { id: requesterId }, select: { name: true } }),
  ]);
  await notifyMany(
    signatories.filter((id) => id !== requesterId),
    {
      kind: 'system',
      title: 'Withdrawal needs your approval',
      detail: `${requester?.name ?? 'A rep'} requested a ${naira(payout.amount)} withdrawal to ${payout.accountName ?? payout.accountMasked}. Open the Payout page to approve or reject it.`,
      href: '/dashboard/payout',
    },
  ).catch(() => {});
  if (!signatories.includes(requesterId)) return { otpSentToRequester: false };
  try {
    await sendApprovalOtp(payout.id, payout.spaceId, requesterId);
    return { otpSentToRequester: true };
  } catch (err) {
    logger.warn({ ref: payout.reference, err: (err as Error).message }, 'could not send the requester their approval code');
    return { otpSentToRequester: false };
  }
}

/** Who has signed a withdrawal, for its detail view. */
export async function getApprovalState(payout: Payout) {
  const [signatories, approvals] = await Promise.all([
    getSignatoryIds(payout.spaceId),
    db.payoutApproval.findMany({ where: { payoutId: payout.id }, include: { rep: { select: { id: true, name: true } } }, orderBy: { decidedAt: 'asc' } }),
  ]);
  return {
    required: REQUIRED_APPROVALS,
    approvedCount: approvals.filter((a) => a.decision === 'approved' && signatories.includes(a.repUserId)).length,
    signatoryIds: signatories,
    approvals: approvals.map((a) => ({ userId: a.rep.id, name: a.rep.name, decision: a.decision, decidedAt: a.decidedAt.toISOString() })),
  };
}

/** Reconciliation: cancel withdrawals whose approval window ran out. */
export async function expireStaleApprovals(): Promise<void> {
  const stale = await db.payout.findMany({
    where: { status: 'awaiting_approval', approvalExpiresAt: { lte: new Date() } },
    select: { id: true, reference: true },
    take: 50,
  });
  for (const p of stale) {
    await cancelPayout(p.id, 'not approved in time').catch((err) => logger.warn({ ref: p.reference, err: (err as Error).message }, 'approval expiry failed'));
  }
}


import { type Prisma, type WithdrawalAuthMode } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { db } from '../config/db';
import { AppError, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { notifyMany } from '../lib/notifications';

/**
 * Signatories: in `multisig` mode a space's withdrawals need 2 of its 3
 * signatories — the lead rep plus the two co-reps the lead nominates — each
 * confirming with a one-time code Duevy emails them.
 *
 * A compromised lead account could otherwise add two accounts it controls as
 * co-reps, nominate them and approve its own withdrawal. So changing the
 * signatories while multisig is on, or switching multisig off, holds
 * withdrawals for 24 hours and tells every rep.
 */

export const REQUIRED_SIGNATORIES = 3;
export const SECURITY_CHANGE_HOLD_MS = 24 * 60 * 60 * 1000;

type Client = Prisma.TransactionClient | typeof db;

/** The space's signatories (lead first). Suspended or deactivated accounts don't count. */
export async function getSignatoryIds(spaceId: string, client: Client = db): Promise<string[]> {
  const reps = await client.spaceRep.findMany({
    where: { spaceId, OR: [{ role: 'lead' }, { isSignatory: true }], user: { isSuspended: false, isDeactivated: false } },
    select: { userId: true },
    orderBy: [{ role: 'asc' }, { addedAt: 'asc' }],
  });
  return reps.map((r) => r.userId);
}

export async function listSignatories(spaceId: string) {
  const reps = await db.spaceRep.findMany({
    where: { spaceId, OR: [{ role: 'lead' }, { isSignatory: true }] },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ role: 'asc' }, { addedAt: 'asc' }],
  });
  return reps.map((r) => ({ id: r.user.id, name: r.user.name, email: r.user.email, role: r.role }));
}

/** Sensitive settings changes need the caller's account password. */
export async function assertPassword(userId: string, password: string): Promise<{ id: string; name: string; email: string }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, passwordHash: true } });
  if (!user) throw notFound('User not found');
  if (!user.passwordHash) {
    throw new AppError(409, 'PASSWORD_REQUIRED', 'Your account has no password yet. Sign out and use "Forgot password" to create one, then try again.');
  }
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(403, 'INVALID_PASSWORD', 'Your password is incorrect', [{ field: 'password', issue: 'incorrect' }]);
  }
  return { id: user.id, name: user.name, email: user.email };
}

async function warnReps(spaceId: string, title: string, detail: string): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    { kind: 'system', tone: 'rose', title, detail, href: '/dashboard/payout' },
  ).catch(() => {});
}

/**
 * The lead nominates the (up to) two co-reps who sign withdrawals with them.
 * While multisig is on it must stay a full set of two, and a change starts a
 * 24-hour hold.
 */
export async function setSignatories(input: {
  spaceId: string;
  userId: string;
  signatoryIds: string[];
  password: string;
}): Promise<{ signatoryIds: string[]; holdUntil: Date | null }> {
  const actor = await assertPassword(input.userId, input.password);
  const wanted = [...new Set(input.signatoryIds)];
  if (wanted.length > REQUIRED_SIGNATORIES - 1) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Nominate at most two co-reps', [{ field: 'userIds', issue: 'at most 2' }]);
  }

  const [space, reps] = await Promise.all([
    db.space.findUnique({ where: { id: input.spaceId } }),
    db.spaceRep.findMany({ where: { spaceId: input.spaceId }, include: { user: { select: { name: true, isSuspended: true, isDeactivated: true } } } }),
  ]);
  if (!space) throw notFound('Space not found');
  const byUser = new Map(reps.map((r) => [r.userId, r]));
  for (const id of wanted) {
    const r = byUser.get(id);
    if (!r || r.role !== 'co') {
      throw new AppError(422, 'VALIDATION_ERROR', 'Signatories must be co-reps of this space', [{ field: 'userIds', issue: `${id} is not a co-rep` }]);
    }
    if (r.user.isSuspended || r.user.isDeactivated) {
      throw new AppError(409, 'USER_INACTIVE', `${r.user.name}'s account is suspended`);
    }
  }

  const current = reps.filter((r) => r.role === 'co' && r.isSignatory).map((r) => r.userId);
  const changed = current.length !== wanted.length || current.some((id) => !wanted.includes(id));
  const multisig = space.withdrawalAuthMode === 'multisig';
  if (multisig && wanted.length < REQUIRED_SIGNATORIES - 1) {
    throw new AppError(409, 'SIGNATORIES_INCOMPLETE', 'Withdrawal approvals are on, so you need two co-rep signatories. Turn approvals off first to remove one.');
  }
  if (!changed) return { signatoryIds: [input.userId, ...wanted], holdUntil: null };

  const holdUntil = multisig ? new Date(Date.now() + SECURITY_CHANGE_HOLD_MS) : null;
  const names = wanted.map((id) => byUser.get(id)!.user.name);
  await db.$transaction(async (tx) => {
    await tx.spaceRep.updateMany({ where: { spaceId: input.spaceId, isSignatory: true }, data: { isSignatory: false } });
    if (wanted.length) await tx.spaceRep.updateMany({ where: { spaceId: input.spaceId, userId: { in: wanted } }, data: { isSignatory: true } });
    if (holdUntil) await tx.space.update({ where: { id: input.spaceId }, data: { withdrawalPinHoldUntil: holdUntil } });
    await writeAudit(
      input.spaceId,
      { id: actor.id, name: actor.name, role: 'lead' },
      'signatories_updated',
      names.length ? `Set the withdrawal signatories to ${actor.name}, ${names.join(' and ')}` : 'Removed the co-rep withdrawal signatories',
      tx,
    );
  });

  if (multisig) {
    await warnReps(
      input.spaceId,
      'Withdrawal signatories changed',
      `${actor.name} changed the signatories for ${space.name} to ${[actor.name, ...names].join(', ')}. Withdrawals are paused for 24 hours. If this wasn't agreed, contact Duevy support now.`,
    );
  }
  return { signatoryIds: [input.userId, ...wanted], holdUntil };
}

/**
 * Switch how withdrawals are authorised. Turning approvals on needs a full set
 * of signatories; turning them off starts a 24-hour hold and tells every rep.
 */
export async function setWithdrawalAuthMode(input: {
  spaceId: string;
  userId: string;
  mode: WithdrawalAuthMode;
  password: string;
}): Promise<{ mode: WithdrawalAuthMode; changed: boolean; holdUntil: Date | null }> {
  const actor = await assertPassword(input.userId, input.password);
  const space = await db.space.findUnique({ where: { id: input.spaceId } });
  if (!space) throw notFound('Space not found');
  const activeHold = space.withdrawalPinHoldUntil && space.withdrawalPinHoldUntil > new Date() ? space.withdrawalPinHoldUntil : null;
  if (space.withdrawalAuthMode === input.mode) return { mode: input.mode, changed: false, holdUntil: activeHold };

  if (input.mode === 'multisig' && (await getSignatoryIds(input.spaceId)).length < REQUIRED_SIGNATORIES) {
    throw new AppError(409, 'SIGNATORIES_INCOMPLETE', 'Nominate two co-reps as signatories before turning on withdrawal approvals.');
  }
  const holdUntil = input.mode === 'pin' ? new Date(Date.now() + SECURITY_CHANGE_HOLD_MS) : activeHold;

  await db.$transaction(async (tx) => {
    await tx.space.update({ where: { id: input.spaceId }, data: { withdrawalAuthMode: input.mode, withdrawalPinHoldUntil: holdUntil } });
    await writeAudit(
      input.spaceId,
      { id: actor.id, name: actor.name, role: 'lead' },
      'withdrawal_mode_changed',
      input.mode === 'multisig'
        ? `${actor.name} turned on signatory approval for withdrawals`
        : `${actor.name} turned off signatory approval; withdrawals now use the security code`,
      tx,
    );
  });

  await warnReps(
    input.spaceId,
    input.mode === 'multisig' ? 'Withdrawal approvals turned on' : 'Withdrawal approvals turned off',
    input.mode === 'multisig'
      ? `${actor.name} turned on approvals for ${space.name}: every withdrawal now needs 2 of the 3 signatories to confirm with a code from Duevy.`
      : `${actor.name} turned off approvals for ${space.name}; withdrawals will use the security code. Withdrawals are paused for 24 hours. If this wasn't agreed, contact Duevy support now.`,
  );
  return { mode: input.mode, changed: true, holdUntil };
}

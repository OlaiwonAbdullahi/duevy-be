import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeSpace, serializeStudent, serializeAuditLog } from '../lib/serializers';
import { writeAudit } from '../lib/audit';
import { notify } from '../lib/notifications';
import { generateJoinCode } from '../lib/joincode';
import { computeCharge } from '../lib/money';
import { sendEmail } from '../lib/email';

// Mounted at /spaces/:spaceId — mergeParams exposes spaceId to these handlers.
export const circleRouter = Router({ mergeParams: true });

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}
function spaceId(req: Request): string {
  return req.params.spaceId as string;
}
async function actor(id: string): Promise<{ id: string; name: string }> {
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  return { id, name: u?.name ?? 'Rep' };
}

// ---------------------------------------------------------------------------
// GET /members — paginated + searchable roster (§5.1)
// ---------------------------------------------------------------------------
circleRouter.get('/members', requireSpaceRep(), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const sid = spaceId(req);

  const where = {
    spaceId: sid,
    ...(q
      ? {
          user: {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { matricNo: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          },
        }
      : {}),
  };

  const [total, memberships] = await Promise.all([
    db.spaceMembership.count({ where }),
    db.spaceMembership.findMany({
      where,
      include: { user: { select: { id: true, name: true, matricNo: true, level: true, email: true } } },
      orderBy: { joinedAt: 'desc' },
      skip,
      take,
    }),
  ]);

  ok(
    res,
    memberships.map((m) => serializeStudent(m.user, m.joinedAt)),
    200,
    buildMeta(page, perPage, total),
  );
});

// ---------------------------------------------------------------------------
// DELETE /members/{userId} — remove a member (§5.2, lead)
// ---------------------------------------------------------------------------
circleRouter.delete('/members/:userId', requireSpaceRep(true), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const targetId = req.params.userId as string;

  const membership = await db.spaceMembership.findUnique({
    where: { userId_spaceId: { userId: targetId, spaceId: sid } },
  });
  if (!membership) {
    errors.notFound(res, 'That user is not a member of this space');
    return;
  }

  await db.spaceMembership.delete({ where: { id: membership.id } });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /join-code/regenerate — rotate the join code (§5.3)
// ---------------------------------------------------------------------------
circleRouter.post('/join-code/regenerate', requireSpaceRep(), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const space = await db.space.findUnique({ where: { id: sid }, select: { short: true } });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }

  // Retry until we land on an unused code.
  let code = generateJoinCode(space.short);
  for (let i = 0; i < 5; i++) {
    const clash = await db.space.findUnique({ where: { joinCode: code } });
    if (!clash) break;
    code = generateJoinCode(space.short);
  }

  await db.space.update({ where: { id: sid }, data: { joinCode: code } });
  await writeAudit(sid, await actor(uid(req)), 'code_regenerated', 'Regenerated the join code');

  ok(res, { code });
});

// ---------------------------------------------------------------------------
// GET /reps — list reps (§5.5)
// ---------------------------------------------------------------------------
circleRouter.get('/reps', requireSpaceRep(), async (req: Request, res: Response): Promise<void> => {
  const reps = await db.spaceRep.findMany({
    where: { spaceId: spaceId(req) },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ role: 'asc' }, { addedAt: 'asc' }],
  });

  ok(
    res,
    reps.map((r) => ({ id: r.user.id, name: r.user.name, email: r.user.email, role: r.role })),
  );
});

// ---------------------------------------------------------------------------
// POST /reps/invite — add a co-rep (§5.6, lead)
// ---------------------------------------------------------------------------
const inviteSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  role: z.literal('co').default('co'),
});

circleRouter.post('/reps/invite', requireSpaceRep(true), validate(inviteSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { email } = req.body as z.infer<typeof inviteSchema>;

  const invitee = await db.user.findUnique({ where: { email } });
  if (!invitee) {
    fail(res, 422, 'USER_NOT_FOUND', 'The invitee must already have a Duevy account', [
      { field: 'email', issue: 'no account found' },
    ]);
    return;
  }

  const existingRep = await db.spaceRep.findUnique({
    where: { userId_spaceId: { userId: invitee.id, spaceId: sid } },
  });
  if (existingRep) {
    errors.conflict(res, 'ALREADY_REP', 'That user is already a rep of this space');
    return;
  }

  const space = await db.space.findUnique({ where: { id: sid }, select: { name: true } });

  await db.$transaction(async (tx) => {
    await tx.spaceRep.create({ data: { userId: invitee.id, spaceId: sid, role: 'co' } });
    // A rep is also a member.
    await tx.spaceMembership.upsert({
      where: { userId_spaceId: { userId: invitee.id, spaceId: sid } },
      update: {},
      create: { userId: invitee.id, spaceId: sid, kind: 'member' },
    });
    await writeAudit(sid, await actor(uid(req)), 'rep_invited', `Invited ${invitee.name} as a co-rep`, tx);
  });

  await notify({
    userId: invitee.id,
    kind: 'system',
    title: 'You are now a co-rep',
    detail: `You were added as a co-rep of ${space?.name ?? 'a space'}.`,
    href: '/dashboard/manage',
  });

  sendEmail({
    to: invitee.email,
    subject: `You're now a co-rep on Duevy`,
    html: `<p>Hi ${invitee.name}, you've been added as a co-rep of <strong>${space?.name ?? 'a space'}</strong> on Duevy.</p>`,
  }).catch(console.error);

  ok(res, { id: invitee.id, name: invitee.name, email: invitee.email, role: 'co' }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /reps/{userId} — remove a co-rep (§5.7, lead)
// ---------------------------------------------------------------------------
circleRouter.delete('/reps/:userId', requireSpaceRep(true), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const targetId = req.params.userId as string;

  const rep = await db.spaceRep.findUnique({ where: { userId_spaceId: { userId: targetId, spaceId: sid } } });
  if (!rep) {
    errors.notFound(res, 'That user is not a rep of this space');
    return;
  }

  if (rep.role === 'lead') {
    const leadCount = await db.spaceRep.count({ where: { spaceId: sid, role: 'lead' } });
    if (leadCount <= 1) {
      errors.conflict(res, 'LAST_LEAD_REP', 'Transfer lead before removing the sole lead rep');
      return;
    }
  }

  const target = await db.user.findUnique({ where: { id: targetId }, select: { name: true } });
  await db.$transaction(async (tx) => {
    await tx.spaceRep.delete({ where: { id: rep.id } });
    await writeAudit(sid, await actor(uid(req)), 'rep_removed', `Removed ${target?.name ?? 'a rep'} as a rep`, tx);
  });

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /audit-log — paginated, newest first (§5.8)
// ---------------------------------------------------------------------------
circleRouter.get('/audit-log', requireSpaceRep(), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const sid = spaceId(req);

  const [total, logs] = await Promise.all([
    db.spaceAuditLog.count({ where: { spaceId: sid } }),
    db.spaceAuditLog.findMany({ where: { spaceId: sid }, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  ok(res, logs.map(serializeAuditLog), 200, buildMeta(page, perPage, total));
});

// ---------------------------------------------------------------------------
// GET /overview — rep dashboard aggregate (§5.9)
// ---------------------------------------------------------------------------
circleRouter.get('/overview', requireSpaceRep(), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);

  const space = await db.space.findUnique({
    where: { id: sid },
    include: { _count: { select: { memberships: true } } },
  });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }
  const memberCount = space._count.memberships;

  const activeDues = await db.due.findMany({ where: { spaceId: sid, status: 'active' } });
  const dueIds = activeDues.map((d) => d.id);

  const payments = dueIds.length
    ? await db.duePayment.findMany({ where: { dueId: { in: dueIds } }, select: { dueId: true, amountPaid: true } })
    : [];

  const paidByDue = new Map<string, { count: number; sum: number }>();
  for (const p of payments) {
    const agg = paidByDue.get(p.dueId) ?? { count: 0, sum: 0 };
    agg.count += 1;
    agg.sum += p.amountPaid;
    paidByDue.set(p.dueId, agg);
  }

  let collected = 0;
  let expected = 0;
  let unpaidCount = 0;
  const activeDuesOut = activeDues.map((d) => {
    const agg = paidByDue.get(d.id) ?? { count: 0, sum: 0 };
    collected += agg.sum;
    expected += computeCharge(d.amount).totalCharged * memberCount;
    unpaidCount += Math.max(0, memberCount - agg.count);
    return {
      id: d.id,
      title: d.title,
      amount: d.amount,
      dueDate: d.dueDate.toISOString().slice(0, 10),
      category: d.category,
      status: d.status,
      paidCount: agg.count,
      memberCount,
    };
  });

  const newMembers = await db.spaceMembership.findMany({
    where: { spaceId: sid },
    include: { user: { select: { id: true, name: true, matricNo: true, level: true, email: true } } },
    orderBy: { joinedAt: 'desc' },
    take: 3,
  });

  ok(res, {
    space: serializeSpace(space, { memberCount }),
    joinCode: space.joinCode,
    stats: {
      collected,
      outstanding: Math.max(0, expected - collected),
      unpaidCount,
      collectionRate: expected > 0 ? collected / expected : 0,
    },
    activeDues: activeDuesOut,
    newMembers: newMembers.map((m) => serializeStudent(m.user, m.joinedAt)),
  });
});

// ---------------------------------------------------------------------------
// POST /transfer-lead — hand over ownership (§5.10, lead)
// ---------------------------------------------------------------------------
const transferSchema = z.object({ userId: z.string().min(1), password: z.string() });

circleRouter.post('/transfer-lead', requireSpaceRep(true), validate(transferSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const callerId = uid(req);
  const { userId: targetId, password } = req.body as z.infer<typeof transferSchema>;

  const caller = await db.user.findUnique({ where: { id: callerId } });
  if (!caller?.passwordHash || !(await bcrypt.compare(password, caller.passwordHash))) {
    fail(res, 400, 'INVALID_CREDENTIALS', 'Password is incorrect', [{ field: 'password', issue: 'incorrect' }]);
    return;
  }

  if (targetId === callerId) {
    errors.conflict(res, 'ALREADY_LEAD', 'You are already the lead');
    return;
  }

  const targetRep = await db.spaceRep.findUnique({ where: { userId_spaceId: { userId: targetId, spaceId: sid } } });
  if (!targetRep) {
    fail(res, 422, 'NOT_A_REP', 'The new lead must already be a rep of this space');
    return;
  }
  if (targetRep.role === 'lead') {
    errors.conflict(res, 'ALREADY_LEAD', 'That user is already the lead');
    return;
  }

  const callerRep = await db.spaceRep.findUnique({ where: { userId_spaceId: { userId: callerId, spaceId: sid } } });
  const target = await db.user.findUnique({ where: { id: targetId }, select: { name: true } });

  await db.$transaction(async (tx) => {
    await tx.spaceRep.update({ where: { id: targetRep.id }, data: { role: 'lead' } });
    if (callerRep) await tx.spaceRep.update({ where: { id: callerRep.id }, data: { role: 'co' } });
    await writeAudit(sid, { id: callerId, name: caller.name }, 'lead_transferred', `Transferred lead to ${target?.name ?? 'a rep'}`, tx);
  });

  await Promise.all([
    notify({ userId: targetId, kind: 'system', title: 'You are now the lead rep', detail: `${caller.name} transferred lead to you.`, href: '/dashboard/manage' }),
    notify({ userId: callerId, kind: 'system', title: 'Lead transferred', detail: `You are now a co-rep of this space.`, href: '/dashboard/manage' }),
  ]);

  ok(res, { success: true });
});

// ---------------------------------------------------------------------------
// POST /archive — archive the department (§5.11, lead)
// ---------------------------------------------------------------------------
const archiveSchema = z.object({ password: z.string(), reason: z.string().max(500).optional() });

circleRouter.post('/archive', requireSpaceRep(true), validate(archiveSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const callerId = uid(req);
  const { password, reason } = req.body as z.infer<typeof archiveSchema>;

  const caller = await db.user.findUnique({ where: { id: callerId } });
  if (!caller?.passwordHash || !(await bcrypt.compare(password, caller.passwordHash))) {
    fail(res, 400, 'INVALID_CREDENTIALS', 'Password is incorrect', [{ field: 'password', issue: 'incorrect' }]);
    return;
  }

  const space = await db.space.findUnique({ where: { id: sid } });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }
  if (space.isArchived) {
    errors.conflict(res, 'ALREADY_ARCHIVED', 'This space is already archived');
    return;
  }

  const pendingPayout = await db.payout.count({ where: { spaceId: sid, status: 'processing' } });
  if (pendingPayout > 0) {
    errors.conflict(res, 'PENDING_PAYOUT', 'Wait for processing payouts to settle before archiving');
    return;
  }

  // Held balance = net collected − amount already paid out.
  const [netAgg, paidOutAgg] = await Promise.all([
    db.duePayment.aggregate({ where: { due: { spaceId: sid } }, _sum: { netToSpace: true } }),
    db.payout.aggregate({ where: { spaceId: sid, status: 'completed' }, _sum: { amount: true } }),
  ]);
  const held = (netAgg._sum.netToSpace ?? 0) - (paidOutAgg._sum.amount ?? 0);
  if (held > 0) {
    errors.conflict(res, 'HELD_BALANCE', 'Pay out the collected balance before archiving');
    return;
  }

  await db.$transaction(async (tx) => {
    await tx.space.update({
      where: { id: sid },
      data: { isArchived: true, archivedAt: new Date(), archivedReason: reason ?? null },
    });
    await writeAudit(sid, { id: callerId, name: caller.name }, 'space_archived', 'Archived the space', tx);
  });

  res.status(204).end();
});

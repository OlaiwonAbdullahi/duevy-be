import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Prisma, type RepApplication } from '@prisma/client';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireAdmin, requireSuperAdmin, requireAdminPermission } from '../middleware/requireRole';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeAppUser, serializeAdminAuditLog, serializeDispute, serializeTransaction } from '../lib/serializers';
import { writeAdminAudit } from '../lib/adminAudit';
import { uniqueReference } from '../services/payment.service';
import { notify } from '../lib/notifications';
import { env } from '../config/env';
import { generateJoinCode } from '../lib/joincode';
import { generateReferralCode } from '../lib/referral';
import { sendRepApprovedEmail, sendRepRejectedEmail } from '../lib/email';
import { renderTablePdf } from '../lib/pdf';

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

const userSpaces = {
  spaceMemberships: { select: { space: { select: { name: true } } } },
  spaceReps: { select: { space: { select: { name: true } } } },
} as const;

// ---------------------------------------------------------------------------
// Shared financial aggregation over a set of spaces.
// ---------------------------------------------------------------------------
async function spacesFinancials(spaceIds: string[]) {
  if (spaceIds.length === 0) return { collected: 0, held: 0, expected: 0, uncollected: 0, collectionRate: 0 };

  const [collectedAgg, paidOutAgg, activeDues, memberGroups] = await Promise.all([
    db.duePayment.aggregate({ where: { due: { spaceId: { in: spaceIds } } }, _sum: { netToSpace: true } }),
    db.payout.aggregate({ where: { spaceId: { in: spaceIds }, status: 'completed' }, _sum: { amount: true } }),
    db.due.findMany({ where: { spaceId: { in: spaceIds }, status: 'active' }, select: { id: true, spaceId: true, amount: true } }),
    db.spaceMembership.groupBy({ by: ['spaceId'], where: { spaceId: { in: spaceIds } }, _count: { _all: true } }),
  ]);

  const memberCount = new Map(memberGroups.map((g) => [g.spaceId, g._count._all]));
  const paidPerDue = new Map(
    (await db.duePayment.groupBy({ by: ['dueId'], where: { dueId: { in: activeDues.map((d) => d.id) } }, _sum: { netToSpace: true } }))
      .map((p) => [p.dueId, p._sum.netToSpace ?? 0]),
  );

  let expected = 0;
  let collectedActive = 0;
  for (const d of activeDues) {
    expected += d.amount * (memberCount.get(d.spaceId) ?? 0);
    collectedActive += paidPerDue.get(d.id) ?? 0;
  }

  const collected = collectedAgg._sum.netToSpace ?? 0;
  return {
    collected,
    held: collected - (paidOutAgg._sum.amount ?? 0),
    expected,
    uncollected: Math.max(0, expected - collectedActive),
    collectionRate: expected > 0 ? collectedActive / expected : 0,
  };
}

/** Count spaces with active dues collecting below 30% of what's expected. */
async function countLowCollectionSpaces(spaceIds: string[]): Promise<number> {
  if (spaceIds.length === 0) return 0;

  const [activeDues, memberGroups] = await Promise.all([
    db.due.findMany({ where: { spaceId: { in: spaceIds }, status: 'active' }, select: { id: true, spaceId: true, amount: true } }),
    db.spaceMembership.groupBy({ by: ['spaceId'], where: { spaceId: { in: spaceIds } }, _count: { _all: true } }),
  ]);
  if (activeDues.length === 0) return 0;

  const memberCount = new Map(memberGroups.map((g) => [g.spaceId, g._count._all]));
  const paidPerDue = new Map(
    (await db.duePayment.groupBy({ by: ['dueId'], where: { dueId: { in: activeDues.map((d) => d.id) } }, _sum: { netToSpace: true } }))
      .map((p) => [p.dueId, p._sum.netToSpace ?? 0]),
  );

  const bySpace = new Map<string, { expected: number; collected: number }>();
  for (const d of activeDues) {
    const agg = bySpace.get(d.spaceId) ?? { expected: 0, collected: 0 };
    agg.expected += d.amount * (memberCount.get(d.spaceId) ?? 0);
    agg.collected += paidPerDue.get(d.id) ?? 0;
    bySpace.set(d.spaceId, agg);
  }

  let count = 0;
  for (const { expected, collected } of bySpace.values()) {
    if (expected > 0 && collected / expected < 0.3) count += 1;
  }
  return count;
}

// ===========================================================================
// §14.1 Overview
// ===========================================================================
adminRouter.get('/overview', async (_req: Request, res: Response): Promise<void> => {
  const [totalUsers, activeReps, pendingReps] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { role: 'rep', isSuspended: false } }),
    db.user.count({ where: { repApplicationStatus: 'pending' } }),
  ]);

  const allSpaces = await db.space.findMany({ where: { isArchived: false }, select: { id: true } });
  const spaceIds = allSpaces.map((s) => s.id);
  const [fin, lowCollectionCount, openDisputes] = await Promise.all([
    spacesFinancials(spaceIds),
    countLowCollectionSpaces(spaceIds),
    db.dispute.findMany({ where: { status: { in: ['open', 'under_review'] } }, select: { slaDays: true, createdAt: true } }),
  ]);
  const breachedDisputes = openDisputes.filter((d) => (Date.now() - d.createdAt.getTime()) / (24 * 60 * 60 * 1000) > d.slaDays).length;

  // Overdue: active dues past their date, still short of full collection.
  const now = new Date();
  const overdueDues = await db.due.findMany({
    where: { status: 'active', dueDate: { lt: now } },
    select: { id: true, spaceId: true, amount: true },
  });
  let overdueAmount = 0;
  let overdueCount = 0;
  if (overdueDues.length) {
    const memberGroups = await db.spaceMembership.groupBy({
      by: ['spaceId'],
      where: { spaceId: { in: overdueDues.map((d) => d.spaceId) } },
      _count: { _all: true },
    });
    const memberCount = new Map(memberGroups.map((g) => [g.spaceId, g._count._all]));
    const paidCounts = new Map(
      (await db.duePayment.groupBy({ by: ['dueId'], where: { dueId: { in: overdueDues.map((d) => d.id) } }, _count: { _all: true } }))
        .map((p) => [p.dueId, p._count._all]),
    );
    for (const d of overdueDues) {
      const unpaid = Math.max(0, (memberCount.get(d.spaceId) ?? 0) - (paidCounts.get(d.id) ?? 0));
      if (unpaid > 0) {
        overdueCount += 1;
        overdueAmount += d.amount * unpaid;
      }
    }
  }

  const attention: unknown[] = [];
  if (pendingReps > 0) {
    attention.push({
      id: 'pending-reps',
      tone: 'warning',
      badge: 'Verification',
      title: `${pendingReps} rep application${pendingReps === 1 ? '' : 's'} awaiting review`,
      detail: 'New reps cannot collect dues until verified.',
      href: '/admin/reps',
      linkLabel: 'Review reps',
    });
  }
  if (overdueCount > 0) {
    attention.push({
      id: 'overdue-dues',
      tone: 'warning',
      badge: 'Overdue',
      title: `${overdueCount} due${overdueCount === 1 ? '' : 's'} past deadline with unpaid balances`,
      detail: `₦${(overdueAmount / 100).toLocaleString('en-NG')} still outstanding across overdue dues.`,
      href: '/admin/spaces',
      linkLabel: 'Review spaces',
    });
  }
  if (lowCollectionCount > 0) {
    attention.push({
      id: 'low-collection',
      tone: 'warning',
      badge: 'Low collection',
      title: `${lowCollectionCount} space${lowCollectionCount === 1 ? '' : 's'} collecting below 30% of expected dues`,
      detail: 'These spaces may need a reminder push or rep follow-up.',
      href: '/admin/spaces',
      linkLabel: 'Review spaces',
    });
  }
  if (breachedDisputes > 0) {
    attention.push({
      id: 'dispute-sla',
      tone: 'warning',
      badge: 'SLA breach',
      title: `${breachedDisputes} dispute${breachedDisputes === 1 ? '' : 's'} past their SLA window`,
      detail: 'Open disputes should be claimed and resolved before their SLA expires.',
      href: '/admin/disputes',
      linkLabel: 'Review disputes',
    });
  }

  ok(res, {
    totalUsers,
    activeReps,
    duesCollected: fin.collected,
    duesTarget: fin.expected,
    floatHeld: Math.max(0, fin.held),
    overdue: { amount: overdueAmount, count: overdueCount },
    attention,
  });
});

// ===========================================================================
// §14.2 Users
// ===========================================================================
adminRouter.get('/users', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const role = typeof req.query.role === 'string' ? req.query.role : undefined;
  const kycStatus = typeof req.query.kycStatus === 'string' ? req.query.kycStatus : undefined;
  const suspended = req.query.suspended;

  const where: Prisma.UserWhereInput = {};
  if (role && ['student', 'rep', 'admin'].includes(role)) where.role = role as never;
  if (kycStatus) where.kycStatus = kycStatus as never;
  if (suspended === 'true') where.isSuspended = true;
  if (suspended === 'false') where.isSuspended = false;
  if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { matricNo: { contains: q, mode: 'insensitive' } }];

  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({ where, include: userSpaces, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  ok(res, users.map(serializeAppUser), 200, buildMeta(page, perPage, total));
});

adminRouter.get('/users/:userId', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const user = await db.user.findUnique({ where: { id: req.params.userId as string }, include: userSpaces });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }
  ok(res, serializeAppUser(user));
});

const reasonSchema = z.object({ reason: z.string().min(1).max(500) });

adminRouter.post('/users/:userId/suspend', requireAdminPermission('userManagement'), validate(reasonSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.userId as string;
  const { reason } = req.body as z.infer<typeof reasonSchema>;
  const updated = await db.user.updateMany({ where: { id }, data: { isSuspended: true, suspendedReason: reason } });
  if (updated.count === 0) {
    errors.notFound(res, 'User not found');
    return;
  }
  await Promise.all([
    db.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    writeAdminAudit(req, 'user.suspend', { target: id, severity: 'warning', metadata: { reason } }),
  ]);
  res.status(204).end();
});

adminRouter.post('/users/:userId/unsuspend', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.userId as string;
  const updated = await db.user.updateMany({ where: { id }, data: { isSuspended: false, suspendedReason: null } });
  if (updated.count === 0) {
    errors.notFound(res, 'User not found');
    return;
  }
  await writeAdminAudit(req, 'user.unsuspend', { target: id });
  res.status(204).end();
});

adminRouter.post('/users/:userId/deactivate', requireAdminPermission('userManagement'), validate(reasonSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.userId as string;
  const { reason } = req.body as z.infer<typeof reasonSchema>;
  const updated = await db.user.updateMany({ where: { id }, data: { isDeactivated: true, deactivatedReason: reason } });
  if (updated.count === 0) {
    errors.notFound(res, 'User not found');
    return;
  }
  await Promise.all([
    db.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    writeAdminAudit(req, 'user.deactivate', { target: id, severity: 'critical', metadata: { reason } }),
  ]);
  res.status(204).end();
});

const kycSchema = z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().max(500).optional() });

adminRouter.post('/users/:userId/kyc/review', requireAdminPermission('userManagement'), validate(kycSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.userId as string;
  const { decision, note } = req.body as z.infer<typeof kycSchema>;
  const updated = await db.user.updateMany({ where: { id }, data: { kycStatus: decision } });
  if (updated.count === 0) {
    errors.notFound(res, 'User not found');
    return;
  }
  await writeAdminAudit(req, 'user.kyc_review', { target: id, metadata: { decision, note: note ?? null } });
  ok(res, { kycStatus: decision });
});

// ===========================================================================
// §14.3 Reps
// ===========================================================================
async function buildAdminRep(user: { id: string; name: string; isSuspended: boolean; repApplicationStatus: string; role: string }) {
  const reps = await db.spaceRep.findMany({ where: { userId: user.id }, select: { spaceId: true } });
  const spaceIds = reps.map((r) => r.spaceId);
  const fin = await spacesFinancials(spaceIds);
  const verification = user.repApplicationStatus === 'approved' || user.role === 'rep' ? 'verified' : user.repApplicationStatus === 'pending' ? 'pending' : 'unverified';
  const status = user.isSuspended ? 'suspended' : user.repApplicationStatus === 'pending' ? 'pending' : 'active';
  return {
    id: user.id,
    name: user.name,
    departmentIds: spaceIds,
    status,
    verification,
    heldAmount: Math.max(0, fin.held),
    uncollectedAmount: fin.uncollected,
    collectionRate: fin.collectionRate,
  };
}

adminRouter.get('/reps', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const where: Prisma.UserWhereInput = {
    OR: [{ role: 'rep' }, { repApplicationStatus: 'pending' }],
  };
  if (q) where.AND = [{ OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }];

  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  const rows = await Promise.all(users.map(buildAdminRep));
  ok(res, rows, 200, buildMeta(page, perPage, total));
});

// ---------------------------------------------------------------------------
// Rep application review queue — the detail an admin needs to approve/reject.
// ---------------------------------------------------------------------------
function serializeRepApplication(app: RepApplication, user?: { id: string; name: string; email: string; matricNo: string | null; level: string | null }) {
  return {
    userId: app.userId,
    applicant: user ? { id: user.id, name: user.name, email: user.email, matricNo: user.matricNo, level: user.level } : null,
    status: app.status,
    requestedSpace: {
      name: app.spaceName,
      short: app.spaceShort,
      kind: app.spaceKind,
      school: app.school,
      faculty: app.faculty,
      theme: app.theme,
    },
    coRepInvites: app.coRepInvites,
    referralCode: app.referralCode,
    submittedAt: app.createdAt.toISOString(),
    reviewedAt: app.reviewedAt?.toISOString() ?? null,
    reviewNote: app.reviewNote,
  };
}

// GET /admin/reps/applications — pending applications (default) with full detail.
adminRouter.get('/reps/applications', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const where: Prisma.RepApplicationWhereInput =
    ['pending', 'approved', 'rejected'].includes(statusFilter) ? { status: statusFilter as never } : { status: 'pending' };

  const [total, apps] = await Promise.all([
    db.repApplication.count({ where }),
    db.repApplication.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  const users = await db.user.findMany({
    where: { id: { in: apps.map((a) => a.userId) } },
    select: { id: true, name: true, email: true, matricNo: true, level: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  ok(res, apps.map((a) => serializeRepApplication(a, byId.get(a.userId))), 200, buildMeta(page, perPage, total));
});

// GET /admin/reps/:repId/application — single application detail.
adminRouter.get('/reps/:repId/application', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.repId as string;
  const app = await db.repApplication.findUnique({ where: { userId } });
  if (!app) {
    errors.notFound(res, 'No application on file for this user');
    return;
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, matricNo: true, level: true } });
  ok(res, serializeRepApplication(app, user ?? undefined));
});

// POST /reps/:repId/verify — the rep-approval keystone.
const verifySchema = z.object({ note: z.string().max(500).optional() });

adminRouter.post('/reps/:repId/verify', requireAdminPermission('userManagement'), validate(verifySchema), async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.repId as string;
  const { note } = req.body as z.infer<typeof verifySchema>;

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }
  if (user.repApplicationStatus !== 'pending') {
    errors.conflict(res, 'NOT_PENDING', 'This account has no pending rep application');
    return;
  }
  const app = await db.repApplication.findUnique({ where: { userId } });
  if (!app) {
    errors.conflict(res, 'NO_APPLICATION', 'No rep application on file');
    return;
  }

  const joinCode = await (async () => {
    let code = generateJoinCode(app.spaceShort);
    for (let i = 0; i < 5; i++) {
      if (!(await db.space.findUnique({ where: { joinCode: code } }))) break;
      code = generateJoinCode(app.spaceShort);
    }
    return code;
  })();
  const referralCode = await generateReferralCode(user.name);

  const space = await db.$transaction(
    async (tx) => {
      const created = await tx.space.create({
        data: {
          name: app.spaceName,
          short: app.spaceShort,
          kind: app.spaceKind,
          theme: app.theme,
          school: app.school,
          faculty: app.faculty,
          joinCode,
        },
      });
      await tx.spaceRep.create({ data: { userId, spaceId: created.id, role: 'lead' } });
      await tx.spaceMembership.create({ data: { userId, spaceId: created.id, kind: 'member' } });
      await tx.user.update({ where: { id: userId }, data: { role: 'rep', repApplicationStatus: 'approved', referralCode } });
      await tx.repApplication.update({ where: { userId }, data: { status: 'approved', spaceId: created.id, reviewedAt: new Date(), reviewNote: note } });
      return created;
    },
    { timeout: 20_000 },
  );

  // Link the referral outside the provisioning transaction (best-effort).
  if (app.referralCode) {
    const referrer = await db.user.findUnique({ where: { referralCode: app.referralCode } });
    if (referrer && referrer.id !== userId) {
      await db.referral
        .upsert({
          where: { referredId: userId },
          update: { status: 'joined' },
          create: { referrerId: referrer.id, referredId: userId, status: 'joined' },
        })
        .catch((err) => console.error('[referral link]', err));
    }
  }

  await writeAdminAudit(req, 'rep.verify', { target: userId, metadata: { spaceId: space.id } });
  sendRepApprovedEmail(user.email, user.name, space.name).catch(console.error);

  ok(res, await buildAdminRep({ ...user, role: 'rep', repApplicationStatus: 'approved' }));
});

adminRouter.post('/reps/:repId/reject', requireAdminPermission('userManagement'), validate(reasonSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.repId as string;
  const { reason } = req.body as z.infer<typeof reasonSchema>;

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.repApplicationStatus !== 'pending') {
    errors.conflict(res, 'NOT_PENDING', 'This account has no pending rep application');
    return;
  }

  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { repApplicationStatus: 'rejected' } }),
    db.repApplication.updateMany({ where: { userId }, data: { status: 'rejected', reviewNote: reason, reviewedAt: new Date() } }),
  ]);
  await writeAdminAudit(req, 'rep.reject', { target: userId, severity: 'warning', metadata: { reason } });
  sendRepRejectedEmail(user.email, user.name, reason).catch(console.error);
  res.status(204).end();
});

adminRouter.post('/reps/:repId/suspend', requireAdminPermission('userManagement'), validate(reasonSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.repId as string;
  const { reason } = req.body as z.infer<typeof reasonSchema>;
  const updated = await db.user.updateMany({ where: { id: userId, role: 'rep' }, data: { isSuspended: true, suspendedReason: reason } });
  if (updated.count === 0) {
    errors.notFound(res, 'Rep not found');
    return;
  }
  await writeAdminAudit(req, 'rep.suspend', { target: userId, severity: 'warning', metadata: { reason } });
  res.status(204).end();
});

adminRouter.post('/reps/:repId/reinstate', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.repId as string;
  await db.user.updateMany({ where: { id: userId }, data: { isSuspended: false, suspendedReason: null } });
  await writeAdminAudit(req, 'rep.reinstate', { target: userId });
  res.status(204).end();
});

async function setPayoutFreeze(req: Request, res: Response, frozen: boolean, reason?: string): Promise<void> {
  const userId = req.params.repId as string;
  const reps = await db.spaceRep.findMany({ where: { userId, role: 'lead' }, select: { spaceId: true } });
  if (reps.length === 0) {
    errors.notFound(res, 'Rep leads no spaces');
    return;
  }
  await db.space.updateMany({
    where: { id: { in: reps.map((r) => r.spaceId) } },
    data: { payoutsFrozen: frozen, frozenReason: frozen ? reason : null },
  });
  await writeAdminAudit(req, frozen ? 'rep.freeze_payouts' : 'rep.unfreeze_payouts', { target: userId, severity: frozen ? 'warning' : 'info', metadata: { reason: reason ?? null } });
  res.status(204).end();
}

adminRouter.post('/reps/:repId/freeze-payouts', requireAdminPermission('payouts'), validate(reasonSchema), async (req: Request, res: Response) => {
  await setPayoutFreeze(req, res, true, (req.body as z.infer<typeof reasonSchema>).reason);
});
adminRouter.post('/reps/:repId/unfreeze-payouts', requireAdminPermission('payouts'), async (req: Request, res: Response) => {
  await setPayoutFreeze(req, res, false);
});

// ===========================================================================
// §14.4 Spaces
// ===========================================================================
adminRouter.get('/spaces', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const kind = typeof req.query.type === 'string' ? req.query.type : undefined;
  const school = typeof req.query.school === 'string' ? req.query.school : undefined;

  const where: Prisma.SpaceWhereInput = {};
  if (kind && ['department', 'association', 'faculty', 'club'].includes(kind)) where.kind = kind as never;
  if (school) where.school = { contains: school, mode: 'insensitive' };
  if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { short: { contains: q, mode: 'insensitive' } }];

  const [total, spaces] = await Promise.all([
    db.space.count({ where }),
    db.space.findMany({ where, include: { _count: { select: { memberships: true } }, reps: { select: { userId: true } } }, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  const rows = await Promise.all(
    spaces.map(async (s) => {
      const fin = await spacesFinancials([s.id]);
      return {
        id: s.id,
        name: s.name,
        short: s.short,
        kind: s.kind,
        school: s.school,
        memberCount: s._count.memberships,
        duesTarget: fin.expected,
        collectedAmount: fin.collected,
        assignedRepIds: s.reps.map((r) => r.userId),
        isArchived: s.isArchived,
        payoutsFrozen: s.payoutsFrozen,
      };
    }),
  );
  ok(res, rows, 200, buildMeta(page, perPage, total));
});

const createSpaceSchema = z.object({
  name: z.string().min(2).max(120),
  short: z.string().min(2).max(6),
  kind: z.enum(['department', 'association', 'faculty', 'club']),
  school: z.string().min(2),
  faculty: z.string().optional(),
});

adminRouter.post('/spaces', requireAdminPermission('userManagement'), validate(createSpaceSchema), async (req: Request, res: Response): Promise<void> => {
  const d = req.body as z.infer<typeof createSpaceSchema>;
  let joinCode = generateJoinCode(d.short);
  for (let i = 0; i < 5; i++) {
    if (!(await db.space.findUnique({ where: { joinCode } }))) break;
    joinCode = generateJoinCode(d.short);
  }
  const space = await db.space.create({ data: { name: d.name, short: d.short, kind: d.kind, school: d.school, faculty: d.faculty, joinCode } });
  await writeAdminAudit(req, 'space.create', { target: space.id, metadata: { name: d.name } });
  ok(res, { id: space.id, name: space.name, short: space.short, kind: space.kind, school: space.school, joinCode: space.joinCode }, 201);
});

const patchSpaceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  short: z.string().min(2).max(6).optional(),
  kind: z.enum(['department', 'association', 'faculty', 'club']).optional(),
  school: z.string().min(2).optional(),
  faculty: z.string().optional(),
});

adminRouter.patch('/spaces/:spaceId', requireAdminPermission('userManagement'), validate(patchSpaceSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.spaceId as string;
  const d = req.body as z.infer<typeof patchSpaceSchema>;
  if (Object.keys(d).length === 0) {
    errors.validation(res, [{ field: 'body', issue: 'at least one field is required' }]);
    return;
  }
  const exists = await db.space.findUnique({ where: { id } });
  if (!exists) {
    errors.notFound(res, 'Space not found');
    return;
  }
  const space = await db.space.update({ where: { id }, data: d });
  await writeAdminAudit(req, 'space.update', { target: id, metadata: { fields: Object.keys(d) } });
  ok(res, { id: space.id, name: space.name, short: space.short, kind: space.kind, school: space.school, faculty: space.faculty });
});

const assignRepSchema = z.object({ userId: z.string().min(1), role: z.enum(['lead', 'co']) });

adminRouter.post('/spaces/:spaceId/assign-rep', requireAdminPermission('userManagement'), validate(assignRepSchema), async (req: Request, res: Response): Promise<void> => {
  const spaceId = req.params.spaceId as string;
  const { userId, role } = req.body as z.infer<typeof assignRepSchema>;

  const [space, user] = await Promise.all([db.space.findUnique({ where: { id: spaceId } }), db.user.findUnique({ where: { id: userId } })]);
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }

  const referralCode = user.referralCode ?? (await generateReferralCode(user.name));
  await db.$transaction(
    async (tx) => {
      await tx.spaceRep.upsert({ where: { userId_spaceId: { userId, spaceId } }, update: { role }, create: { userId, spaceId, role } });
      await tx.spaceMembership.upsert({ where: { userId_spaceId: { userId, spaceId } }, update: {}, create: { userId, spaceId, kind: 'member' } });
      // Attaching a rep promotes the account.
      await tx.user.update({ where: { id: userId }, data: { role: 'rep', referralCode } });
    },
    { timeout: 20_000 },
  );
  await writeAdminAudit(req, 'space.assign_rep', { target: spaceId, metadata: { userId, role } });
  ok(res, { userId, spaceId, role }, 201);
});

adminRouter.post('/spaces/:spaceId/archive', requireAdminPermission('userManagement'), validate(reasonSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.spaceId as string;
  const { reason } = req.body as z.infer<typeof reasonSchema>;
  const updated = await db.space.updateMany({ where: { id }, data: { isArchived: true, archivedAt: new Date(), archivedReason: reason } });
  if (updated.count === 0) {
    errors.notFound(res, 'Space not found');
    return;
  }
  await writeAdminAudit(req, 'space.archive', { target: id, severity: 'warning', metadata: { reason } });
  res.status(204).end();
});

// ===========================================================================
// §14.5 Transactions oversight
// ===========================================================================
function adminTxnType(type: string): string {
  return { topup: 'deposit', due: 'dues_payment', withdrawal: 'payout' }[type] ?? type;
}

adminRouter.get('/transactions', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const where: Prisma.TransactionWhereInput = {};
  const typeMap: Record<string, string> = { deposit: 'topup', dues_payment: 'due', payout: 'withdrawal', refund: 'refund' };
  if (typeof req.query.type === 'string') where.type = (typeMap[req.query.type] ?? req.query.type) as never;
  if (typeof req.query.status === 'string') where.status = req.query.status as never;
  if (typeof req.query.spaceId === 'string') where.spaceId = req.query.spaceId;
  if (typeof req.query.userId === 'string') where.userId = req.query.userId;
  if (typeof req.query.from === 'string' || typeof req.query.to === 'string') {
    where.createdAt = {};
    if (typeof req.query.from === 'string') where.createdAt.gte = new Date(req.query.from);
    if (typeof req.query.to === 'string') where.createdAt.lte = new Date(req.query.to);
  }
  if (q) where.OR = [{ reference: { contains: q, mode: 'insensitive' } }, { user: { name: { contains: q, mode: 'insensitive' } } }, { user: { email: { contains: q, mode: 'insensitive' } } }];

  const [total, rows] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findMany({
      where,
      include: { user: { select: { name: true, email: true } }, refunds: { select: { amount: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
  ]);

  const spaceIds = [...new Set(rows.map((r) => r.spaceId).filter(Boolean) as string[])];
  const spaces = await db.space.findMany({ where: { id: { in: spaceIds } }, select: { id: true, name: true } });
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));

  ok(
    res,
    rows.map((t) => {
      const refundedTotal = t.refunds.reduce((s, r) => s + r.amount, 0);
      const fullyRefunded = t.type !== 'refund' && refundedTotal > 0 && refundedTotal >= Math.abs(t.amount);
      return {
        ...serializeTransaction(t),
        type: adminTxnType(t.type),
        status: fullyRefunded ? 'refunded' : t.status,
        refundOfTxnId: t.refundOfTxnId,
        userName: t.user.name,
        userEmail: t.user.email,
        spaceName: t.spaceId ? spaceName.get(t.spaceId) ?? null : null,
      };
    }),
    200,
    buildMeta(page, perPage, total),
  );
});

const refundSchema = z.object({ amount: z.number().int().positive().optional(), reason: z.string().min(1).max(500) });

adminRouter.post('/transactions/:txnId/refund', requireAdminPermission('overrides'), validate(refundSchema), async (req: Request, res: Response): Promise<void> => {
  const { amount, reason } = req.body as z.infer<typeof refundSchema>;
  const original = await db.transaction.findUnique({ where: { id: req.params.txnId as string } });
  if (!original) {
    errors.notFound(res, 'Transaction not found');
    return;
  }
  if (original.type === 'refund') {
    errors.conflict(res, 'NOT_REFUNDABLE', 'Refund transactions cannot themselves be refunded');
    return;
  }
  if (original.status !== 'completed') {
    errors.conflict(res, 'NOT_REFUNDABLE', 'Only completed transactions can be refunded');
    return;
  }

  const alreadyRefunded = await db.transaction.aggregate({
    where: { refundOfTxnId: original.id },
    _sum: { amount: true },
  });
  const refundable = Math.abs(original.amount) - (alreadyRefunded._sum.amount ?? 0);
  if (refundable <= 0) {
    errors.conflict(res, 'ALREADY_REFUNDED', 'This transaction has already been fully refunded');
    return;
  }

  const refundAmount = amount ?? refundable;
  if (refundAmount > refundable) {
    errors.validation(res, [{ field: 'amount', issue: 'exceeds the remaining refundable amount' }]);
    return;
  }

  const reference = await uniqueReference();
  const refund = await db.$transaction(async (tx) => {
    const created = await tx.transaction.create({
      data: {
        userId: original.userId,
        type: 'refund',
        title: 'Refund',
        detail: reason,
        amount: refundAmount,
        method: original.method,
        status: 'completed',
        reference,
        spaceId: original.spaceId,
        refundOfTxnId: original.id,
      },
    });
    await tx.user.update({ where: { id: original.userId }, data: { walletBalance: { increment: refundAmount } } });
    return created;
  });

  await Promise.all([
    writeAdminAudit(req, 'transaction.refund', { target: original.id, severity: 'critical', metadata: { refundAmount, reason } }),
    notify({ userId: original.userId, kind: 'system', tone: 'brand', title: 'Refund issued', detail: `₦${(refundAmount / 100).toLocaleString('en-NG')} was refunded to your wallet.`, href: '/dashboard/wallet' }).catch(() => {}),
  ]);
  ok(res, serializeTransaction(refund), 201);
});

// ===========================================================================
// §14.6 Disputes
// ===========================================================================
adminRouter.get('/disputes', requireAdminPermission('disputes'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const where: Prisma.DisputeWhereInput = {};
  if (typeof req.query.status === 'string') where.status = req.query.status as never;
  if (typeof req.query.type === 'string') where.type = req.query.type as never;
  if (q) where.OR = [{ openedByName: { contains: q, mode: 'insensitive' } }, { openedByEmail: { contains: q, mode: 'insensitive' } }, { txnReference: { contains: q, mode: 'insensitive' } }];

  const [total, disputes] = await Promise.all([
    db.dispute.count({ where }),
    db.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  ok(res, disputes.map(serializeDispute), 200, buildMeta(page, perPage, total));
});

adminRouter.post('/disputes/:id/claim', requireAdminPermission('disputes'), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const dispute = await db.dispute.findUnique({ where: { id } });
  if (!dispute) {
    errors.notFound(res, 'Dispute not found');
    return;
  }
  if (dispute.status === 'resolved') {
    errors.conflict(res, 'DISPUTE_RESOLVED', 'This dispute is already resolved');
    return;
  }
  const updated = await db.dispute.update({ where: { id }, data: { status: 'under_review', claimedById: (req as AuthenticatedRequest).user.sub as string } });
  await writeAdminAudit(req, 'dispute.claim', { target: id });
  ok(res, serializeDispute(updated));
});

const resolveDisputeSchema = z.object({ resolution: z.enum(['upheld', 'rejected']), note: z.string().min(1).max(1000), refundTxnId: z.string().optional() });

adminRouter.post('/disputes/:id/resolve', requireAdminPermission('disputes'), validate(resolveDisputeSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { resolution, note, refundTxnId } = req.body as z.infer<typeof resolveDisputeSchema>;
  const dispute = await db.dispute.findUnique({ where: { id } });
  if (!dispute) {
    errors.notFound(res, 'Dispute not found');
    return;
  }
  const updated = await db.dispute.update({ where: { id }, data: { status: 'resolved', resolution: `${resolution}: ${note}`, refundTxnId, resolvedAt: new Date() } });
  await Promise.all([
    writeAdminAudit(req, 'dispute.resolve', { target: id, severity: 'warning', metadata: { resolution, note } }),
    notify({ userId: dispute.openedById, kind: 'system', title: 'Dispute resolved', detail: `Your dispute was ${resolution}. ${note}`, href: '/dashboard' }).catch(() => {}),
  ]);
  ok(res, serializeDispute(updated));
});

// ===========================================================================
// §14.7 Polls oversight
// ===========================================================================
adminRouter.get('/polls', async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const where: Prisma.PollWhereInput = {};
  if (typeof req.query.status === 'string') where.status = req.query.status as never;
  if (q) where.title = { contains: q, mode: 'insensitive' };

  const [total, polls] = await Promise.all([
    db.poll.count({ where }),
    db.poll.findMany({ where, include: { space: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  ok(
    res,
    polls.map((p) => ({ id: p.id, title: p.title, status: p.status, space: p.space.name, paid: p.paid, totalVotes: p.totalVotes, revenue: p.revenue, deadline: p.deadline.toISOString(), createdAt: p.createdAt.toISOString() })),
    200,
    buildMeta(page, perPage, total),
  );
});

adminRouter.post('/polls/:pollId/close', requireAdminPermission('overrides'), validate(reasonSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.pollId as string;
  const { reason } = req.body as z.infer<typeof reasonSchema>;
  const poll = await db.poll.findUnique({ where: { id } });
  if (!poll) {
    errors.notFound(res, 'Poll not found');
    return;
  }
  await db.poll.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });
  await writeAdminAudit(req, 'poll.force_close', { target: id, severity: 'warning', metadata: { reason } });
  res.status(204).end();
});

// ===========================================================================
// §14.8 Referral integrity
// ===========================================================================
adminRouter.get('/referrals/summaries', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);

  const grouped = await db.referral.groupBy({ by: ['referrerId'], _count: { _all: true }, _sum: { reward: true } });
  const total = grouped.length;
  const pageSlice = grouped.slice(skip, skip + take);

  const referrers = await db.user.findMany({
    where: { id: { in: pageSlice.map((g) => g.referrerId) } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(referrers.map((u) => [u.id, u]));

  const rows = await Promise.all(
    pageSlice.map(async (g) => {
      const joined = await db.referral.count({ where: { referrerId: g.referrerId, status: { in: ['joined', 'paid'] } } });
      const invited = g._count._all;
      // Simple heuristic: a low join-through rate on many invites looks riskier.
      const ratio = invited > 0 ? joined / invited : 0;
      const riskTier = invited >= 10 && ratio < 0.2 ? 'high' : invited >= 5 && ratio < 0.4 ? 'medium' : 'low';
      const u = byId.get(g.referrerId);
      return {
        userId: g.referrerId,
        userName: u?.name ?? 'Unknown',
        email: u?.email ?? '',
        invited,
        joined,
        earned: g._sum.reward ?? 0,
        riskTier,
      };
    }),
  );
  ok(res, rows, 200, buildMeta(page, perPage, total));
});

adminRouter.get('/referrals/flags', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where: Prisma.ReferralFlagWhereInput = {};
  if (status && ['pending', 'paid', 'voided', 'clawed_back'].includes(status)) where.status = status as never;

  const [total, flags] = await Promise.all([
    db.referralFlag.count({ where }),
    db.referralFlag.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  ok(
    res,
    flags.map((f) => ({
      id: f.id,
      referrer: f.referrerName,
      referred: f.referredName,
      label: f.label,
      description: f.description,
      amount: f.amount,
      status: f.status,
      date: f.createdAt.toISOString(),
    })),
    200,
    buildMeta(page, perPage, total),
  );
});

const resolveFlagSchema = z.object({ action: z.enum(['approve', 'void', 'claw_back']), note: z.string().max(500).optional() });

adminRouter.post('/referrals/flags/:flagId/resolve', requireAdminPermission('overrides'), validate(resolveFlagSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.flagId as string;
  const { action, note } = req.body as z.infer<typeof resolveFlagSchema>;
  const statusMap = { approve: 'paid', void: 'voided', claw_back: 'clawed_back' } as const;

  const flag = await db.referralFlag.findUnique({ where: { id } });
  if (!flag) {
    errors.notFound(res, 'Flag not found');
    return;
  }
  const updated = await db.referralFlag.update({ where: { id }, data: { status: statusMap[action], note, resolvedAt: new Date() } });
  await writeAdminAudit(req, 'referral_flag.resolve', { target: id, severity: 'warning', metadata: { action, note: note ?? null } });
  ok(res, { id: updated.id, status: updated.status });
});

// ===========================================================================
// §14.9 Audit logs & roles
// ===========================================================================
adminRouter.get('/audit-logs', async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const where: Prisma.AdminAuditLogWhereInput = {};
  if (typeof req.query.severity === 'string') where.severity = req.query.severity;
  if (typeof req.query.actorId === 'string') where.actorId = req.query.actorId;
  if (typeof req.query.from === 'string' || typeof req.query.to === 'string') {
    where.createdAt = {};
    if (typeof req.query.from === 'string') where.createdAt.gte = new Date(req.query.from);
    if (typeof req.query.to === 'string') where.createdAt.lte = new Date(req.query.to);
  }

  const [total, logs] = await Promise.all([
    db.adminAuditLog.count({ where }),
    db.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  ok(res, logs.map(serializeAdminAuditLog), 200, buildMeta(page, perPage, total));
});

const ROLE_KEYS = ['super_admin', 'compliance_officer', 'support_lead'] as const;

adminRouter.get('/roles', async (_req: Request, res: Response): Promise<void> => {
  const rows = await Promise.all(
    ROLE_KEYS.map(async (role) => {
      const [userCount, sample] = await Promise.all([
        db.user.count({ where: { adminSubRole: role } }),
        db.adminPermission.findFirst({ where: { user: { adminSubRole: role } } }),
      ]);
      return {
        role,
        userCount,
        permissions: {
          userManagement: sample?.userManagement ?? false,
          payouts: sample?.payouts ?? false,
          disputes: sample?.disputes ?? false,
          overrides: sample?.overrides ?? false,
        },
      };
    }),
  );
  ok(res, rows);
});

const rolePermsSchema = z.object({
  userManagement: z.boolean(),
  payouts: z.boolean(),
  disputes: z.boolean(),
  overrides: z.boolean(),
});

adminRouter.put('/roles/:role', requireSuperAdmin(), validate(rolePermsSchema), async (req: Request, res: Response): Promise<void> => {
  const role = req.params.role as string;
  if (!ROLE_KEYS.includes(role as never)) {
    errors.notFound(res, 'Unknown role');
    return;
  }
  const perms = req.body as z.infer<typeof rolePermsSchema>;
  const admins = await db.user.findMany({ where: { adminSubRole: role as never }, select: { id: true } });
  await db.$transaction(
    admins.map((a) => db.adminPermission.upsert({ where: { userId: a.id }, update: perms, create: { userId: a.id, ...perms } })),
  );
  await writeAdminAudit(req, 'roles.update', { target: role, severity: 'critical', metadata: perms });
  ok(res, { role, permissions: perms });
});

// ===========================================================================
// §14.9 Reports
// ===========================================================================
function csv(rows: (string | number | null)[][]): string {
  return rows
    .map((r) => r.map((c) => (c === null ? '' : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(','))
    .join('\n');
}

function serializeReport(r: {
  id: string;
  scope: string;
  format: string;
  status: string;
  generatedAt: Date | null;
  fileSize: number | null;
  downloadUrl: string | null;
  fromDate: Date;
  toDate: Date;
  createdAt: Date;
}) {
  return {
    id: r.id,
    name: `${r.scope} (${r.fromDate.toISOString().slice(0, 10)} – ${r.toDate.toISOString().slice(0, 10)})`,
    scope: r.scope,
    format: r.format,
    status: r.status,
    generatedAt: r.generatedAt?.toISOString() ?? null,
    fileSize: r.fileSize,
    downloadUrl: r.downloadUrl,
    createdAt: r.createdAt.toISOString(),
  };
}

const createReportSchema = z.object({
  scope: z.enum(['financial_summary', 'space_collection', 'rep_performance', 'full_ledger']),
  format: z.enum(['csv', 'pdf']),
  from: z.string(),
  to: z.string(),
  spaceId: z.string().optional(),
});

adminRouter.post('/reports', requireAdminPermission('userManagement'), validate(createReportSchema), async (req: Request, res: Response): Promise<void> => {
  const d = req.body as z.infer<typeof createReportSchema>;
  const now = new Date();

  // Synchronous generation: the file is rendered on demand at download time.
  const report = await db.report.create({
    data: {
      requestedById: (req as AuthenticatedRequest).user.sub as string,
      scope: d.scope,
      format: d.format,
      status: 'ready',
      fromDate: new Date(d.from),
      toDate: new Date(d.to),
      spaceId: d.spaceId,
      generatedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  const downloadUrl = `${env.APP_BASE_URL}/v1/admin/reports/${report.id}/download`;
  await db.report.update({ where: { id: report.id }, data: { downloadUrl } });

  await writeAdminAudit(req, 'report.generate', { target: report.id, metadata: { scope: d.scope, format: d.format } });
  res.status(202).json({ success: true, data: serializeReport({ ...report, downloadUrl }) });
});

adminRouter.get('/reports', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const [total, reports] = await Promise.all([
    db.report.count(),
    db.report.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  ok(res, reports.map(serializeReport), 200, buildMeta(page, perPage, total));
});

adminRouter.get('/reports/:id/download', requireAdminPermission('userManagement'), async (req: Request, res: Response): Promise<void> => {
  const report = await db.report.findUnique({ where: { id: req.params.id as string } });
  if (!report) {
    errors.notFound(res, 'Report not found');
    return;
  }
  if (report.expiresAt && report.expiresAt < new Date()) {
    await db.report.update({ where: { id: report.id }, data: { status: 'expired' } }).catch(() => {});
    errors.conflict(res, 'REPORT_EXPIRED', 'This report link has expired');
    return;
  }

  const range = { gte: report.fromDate, lte: report.toDate };
  let rows: (string | number | null)[][];

  if (report.scope === 'full_ledger') {
    const txns = await db.transaction.findMany({ where: { createdAt: range }, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' } });
    rows = [
      ['Reference', 'Type', 'Title', 'Amount (kobo)', 'Method', 'Status', 'User', 'Email', 'Date'],
      ...txns.map((t) => [t.reference, t.type, t.title, t.amount, t.method, t.status, t.user.name, t.user.email, t.createdAt.toISOString()]),
    ];
  } else if (report.scope === 'financial_summary') {
    const [collected, fees, topups, refunds, payouts] = await Promise.all([
      db.duePayment.aggregate({ where: { paidAt: range }, _sum: { netToSpace: true } }),
      db.duePayment.aggregate({ where: { paidAt: range }, _sum: { monnifyFee: true, duevyFee: true } }),
      db.transaction.aggregate({ where: { type: 'topup', status: 'completed', createdAt: range }, _sum: { amount: true } }),
      db.transaction.aggregate({ where: { type: 'refund', createdAt: range }, _sum: { amount: true } }),
      db.payout.aggregate({ where: { requestedAt: range }, _sum: { amount: true } }),
    ]);
    rows = [
      ['Metric', 'Amount (kobo)'],
      ['Net collected (to spaces)', collected._sum.netToSpace ?? 0],
      ['Monnify fees', fees._sum.monnifyFee ?? 0],
      ['Duevy revenue (fees)', fees._sum.duevyFee ?? 0],
      ['Wallet top-ups', topups._sum.amount ?? 0],
      ['Refunds issued', refunds._sum.amount ?? 0],
      ['Payouts requested', payouts._sum.amount ?? 0],
    ];
  } else if (report.scope === 'space_collection') {
    const where = report.spaceId ? { id: report.spaceId } : {};
    const spaces = await db.space.findMany({ where, select: { id: true, name: true } });
    rows = [['Space', 'Net collected (kobo)', 'Fees (kobo)']];
    for (const s of spaces) {
      const agg = await db.duePayment.aggregate({ where: { due: { spaceId: s.id }, paidAt: range }, _sum: { netToSpace: true, monnifyFee: true, duevyFee: true } });
      rows.push([s.name, agg._sum.netToSpace ?? 0, (agg._sum.monnifyFee ?? 0) + (agg._sum.duevyFee ?? 0)]);
    }
  } else {
    // rep_performance
    const leads = await db.spaceRep.findMany({ where: { role: 'lead' }, include: { user: { select: { name: true } }, space: { select: { name: true } } } });
    rows = [['Rep', 'Space', 'Net collected (kobo)']];
    for (const l of leads) {
      const agg = await db.duePayment.aggregate({ where: { due: { spaceId: l.spaceId }, paidAt: range }, _sum: { netToSpace: true } });
      rows.push([l.user.name, l.space.name, agg._sum.netToSpace ?? 0]);
    }
  }

  if (report.format === 'pdf') {
    const pdf = await renderTablePdf(`${report.scope} report`, rows);
    await db.report.update({ where: { id: report.id }, data: { fileSize: pdf.byteLength } }).catch(() => {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.scope}-${report.id}.pdf"`);
    res.status(200).send(pdf);
    return;
  }

  const body = csv(rows);
  await db.report.update({ where: { id: report.id }, data: { fileSize: Buffer.byteLength(body) } }).catch(() => {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.scope}-${report.id}.csv"`);
  res.status(200).send(body);
});

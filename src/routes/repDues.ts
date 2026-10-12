import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Prisma, type RepRole } from '@prisma/client';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeRepDue } from '../lib/serializers';
import { generateId } from '../lib/id';
import { computeCharge } from '../lib/money';
import { DUE_TYPES } from '../lib/dueTypes';
import { getSpaceKycState } from '../services/kyc.service';
import { writeAudit } from '../lib/audit';
import { notify, notifyMany } from '../lib/notifications';

// Mounted at /spaces/:spaceId — every route is rep-gated.
export const repDuesRouter = Router({ mergeParams: true });
repDuesRouter.use(requireSpaceRep());

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}
function spaceId(req: Request): string {
  return req.params.spaceId as string;
}
async function actor(req: Request): Promise<{ id: string; name: string; role: RepRole | null }> {
  const id = uid(req);
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  const role = (req as AuthenticatedRequest).spaceRep?.role ?? null;
  return { id, name: u?.name ?? 'Rep', role };
}

/** Load a due and confirm it belongs to the space in the path. */
async function loadDue(sid: string, dueId: string) {
  const due = await db.due.findUnique({ where: { id: dueId } });
  if (!due || due.spaceId !== sid) return null;
  return due;
}

async function repDuePayload(sid: string, due: Awaited<ReturnType<typeof loadDue>>) {
  if (!due) throw new Error('due required');
  const [paidCount, memberCount] = await Promise.all([
    db.duePayment.count({ where: { dueId: due.id } }),
    db.spaceMembership.count({ where: { spaceId: sid } }),
  ]);
  return serializeRepDue(due, { paidCount, memberCount });
}

const dueDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'invalid date');

const categoryField = z.enum(DUE_TYPES);

// ₦1,000,000 in kobo. Due amounts live in an Int4 column and are multiplied
// by member counts and fees, so an unbounded amount overflows into a 500.
export const MAX_DUE_AMOUNT_KOBO = 100_000_000;

/** `type` is the field name; `category` is accepted as its legacy alias. */
function typeAlias(req: Request, _res: Response, next: () => void): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.type !== undefined && body.category === undefined) body.category = body.type;
  delete body.type;
  req.body = body;
  next();
}

/** A space may only open dues for payment once its lead rep has passed KYC. */
async function assertCanCollect(sid: string, res: Response): Promise<boolean> {
  const kyc = await getSpaceKycState(sid);
  if (kyc.canCollect) return true;
  errors.conflict(
    res,
    'KYC_REQUIRED',
    'Complete identity verification before publishing dues. You can keep them as drafts until then.',
  );
  return false;
}

// ---------------------------------------------------------------------------
// GET /dues — all dues the space has raised (§7.1)
// ---------------------------------------------------------------------------
const listDuesQuery = z.object({
  status: z.enum(['draft', 'active', 'closed']).optional(),
  category: categoryField.optional(),
  type: categoryField.optional(),
});

repDuesRouter.get('/dues', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const parsed = listDuesQuery.safeParse(req.query);
  if (!parsed.success) {
    errors.validation(res, parsed.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const { status } = parsed.data;
  const category = parsed.data.type ?? parsed.data.category;

  const dues = await db.due.findMany({
    where: { spaceId: sid, ...(status ? { status } : {}), ...(category ? { category } : {}) },
    orderBy: { createdAt: 'desc' },
  });

  const memberCount = await db.spaceMembership.count({ where: { spaceId: sid } });
  const paidCounts = await db.duePayment.groupBy({
    by: ['dueId'],
    where: { dueId: { in: dues.map((d) => d.id) } },
    _count: { _all: true },
  });
  const paidByDue = new Map(paidCounts.map((p) => [p.dueId, p._count._all]));

  ok(
    res,
    dues.map((d) => serializeRepDue(d, { paidCount: paidByDue.get(d.id) ?? 0, memberCount })),
  );
});

// ---------------------------------------------------------------------------
// POST /dues — create a due (§7.2)
// ---------------------------------------------------------------------------
const createDueSchema = z.object({
  title: z.string().min(3).max(120),
  note: z.string().max(500).optional(),
  amount: z.number().int().positive().max(MAX_DUE_AMOUNT_KOBO),
  dueDate: dueDateField.refine((s) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return new Date(`${s}T00:00:00Z`) >= today;
  }, 'must be today or later'),
  category: categoryField,
  publish: z.boolean().default(false),
});

repDuesRouter.post('/dues', typeAlias, validate(createDueSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const data = req.body as z.infer<typeof createDueSchema>;
  const publishing = data.publish;
  if (publishing && !(await assertCanCollect(sid, res))) return;

  const due = await db.$transaction(async (tx) => {
    const created = await tx.due.create({
      data: {
        id: generateId('due'),
        spaceId: sid,
        title: data.title,
        note: data.note,
        amount: data.amount,
        dueDate: new Date(`${data.dueDate}T00:00:00Z`),
        category: data.category,
        status: publishing ? 'active' : 'draft',
        publishedAt: publishing ? new Date() : null,
        assignedRepId: uid(req),
      },
    });
    if (publishing) {
      await writeAudit(sid, await actor(req),'due_published', `Published due "${created.title}"`, tx);
    }
    return created;
  });

  ok(res, await repDuePayload(sid, due), 201);
});

// ---------------------------------------------------------------------------
// PATCH /dues/{dueId} — edit a draft or active due (§7.3)
// ---------------------------------------------------------------------------
const patchDueSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  note: z.string().max(500).optional(),
  amount: z.number().int().positive().max(MAX_DUE_AMOUNT_KOBO).optional(),
  dueDate: dueDateField.optional(),
  category: categoryField.optional(),
});

repDuesRouter.patch('/dues/:dueId', typeAlias, validate(patchDueSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const data = req.body as z.infer<typeof patchDueSchema>;

  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }
  if (due.status === 'closed') {
    errors.conflict(res, 'DUE_CLOSED', 'A closed due can no longer be edited');
    return;
  }
  if (Object.keys(data).length === 0) {
    errors.validation(res, [{ field: 'body', issue: 'at least one field is required' }]);
    return;
  }

  // amount is immutable once any payment exists.
  if (data.amount !== undefined && data.amount !== due.amount) {
    const payments = await db.duePayment.count({ where: { dueId: due.id } });
    if (payments > 0) {
      errors.conflict(res, 'DUE_HAS_PAYMENTS', 'Amount cannot change after payments have been made');
      return;
    }
  }

  const updated = await db.due.update({
    where: { id: due.id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.dueDate !== undefined ? { dueDate: new Date(`${data.dueDate}T00:00:00Z`) } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
    },
  });

  ok(res, await repDuePayload(sid, updated));
});

// ---------------------------------------------------------------------------
// POST /dues/{dueId}/publish · /close — lifecycle (§7.4)
// ---------------------------------------------------------------------------
repDuesRouter.post('/dues/:dueId/publish', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }
  if (due.status !== 'draft') {
    errors.conflict(res, 'INVALID_TRANSITION', 'Only a draft due can be published');
    return;
  }
  if (!(await assertCanCollect(sid, res))) return;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.due.update({ where: { id: due.id }, data: { status: 'active', publishedAt: new Date() } });
    await writeAudit(sid, await actor(req),'due_published', `Published due "${u.title}"`, tx);
    return u;
  });

  ok(res, await repDuePayload(sid, updated));
});

repDuesRouter.post('/dues/:dueId/close', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }
  if (due.status !== 'active') {
    errors.conflict(res, 'INVALID_TRANSITION', 'Only an active due can be closed');
    return;
  }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.due.update({ where: { id: due.id }, data: { status: 'closed', closedAt: new Date() } });
    await writeAudit(sid, await actor(req),'due_closed', `Closed due "${u.title}"`, tx);
    return u;
  });

  ok(res, await repDuePayload(sid, updated));
});

// ---------------------------------------------------------------------------
// DELETE /dues/{dueId} — drafts only (§7.5)
// ---------------------------------------------------------------------------
repDuesRouter.delete('/dues/:dueId', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }
  if (due.status !== 'draft') {
    errors.conflict(res, 'ONLY_DRAFTS_DELETABLE', 'Only draft dues can be deleted');
    return;
  }

  await db.due.delete({ where: { id: due.id } });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /dues/{dueId}/reassign — lead-only. Hands this due's payout-scoping
// off to a different co-rep. A lead is never a valid target: they already
// have unrestricted space-wide payout access regardless of assignment.
// ---------------------------------------------------------------------------
const reassignSchema = z.object({ userId: z.string().min(1) });

repDuesRouter.post(
  '/dues/:dueId/reassign',
  requireSpaceRep(true),
  validate(reassignSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { userId: targetId } = req.body as z.infer<typeof reassignSchema>;

    const due = await loadDue(sid, req.params.dueId as string);
    if (!due) {
      errors.notFound(res, 'Due not found');
      return;
    }

    const targetRep = await db.spaceRep.findUnique({
      where: { userId_spaceId: { userId: targetId, spaceId: sid } },
    });
    if (!targetRep || targetRep.role !== 'co') {
      errors.validation(res, [{ field: 'userId', issue: 'must be an existing co-rep of this space' }]);
      return;
    }
    if (due.assignedRepId === targetId) {
      errors.conflict(res, 'ALREADY_ASSIGNED', 'This due is already assigned to that rep');
      return;
    }

    const target = await db.user.findUnique({ where: { id: targetId }, select: { name: true } });

    const updated = await db.$transaction(async (tx) => {
      const u = await tx.due.update({ where: { id: due.id }, data: { assignedRepId: targetId } });
      await writeAudit(
        sid,
        await actor(req),
        'due_reassigned',
        `Reassigned due "${u.title}" to ${target?.name ?? 'a rep'}`,
        tx,
      );
      return u;
    });

    await notify({
      userId: targetId,
      kind: 'system',
      title: 'A due was assigned to you',
      detail: `"${updated.title}" is now assigned to you — you can request payout against its collected funds.`,
      href: '/dashboard/dues',
    });

    ok(res, await repDuePayload(sid, updated));
  },
);

// ---------------------------------------------------------------------------
// Collections roster — shared builder for §7.6 (JSON) and §7.8 (CSV)
// ---------------------------------------------------------------------------
type RosterStatus = 'all' | 'paid' | 'unpaid';

async function buildRoster(
  sid: string,
  dueId: string,
  filter: RosterStatus,
  q?: string,
  pageOpts?: { skip: number; take: number },
) {
  // Filter and paginate memberships in the DB; payments are then fetched only
  // for the page's users.
  const userConds: Prisma.UserWhereInput[] = [];
  if (filter === 'paid') userConds.push({ duePayments: { some: { dueId } } });
  if (filter === 'unpaid') userConds.push({ duePayments: { none: { dueId } } });
  if (q) {
    userConds.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { matricNo: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  const where: Prisma.SpaceMembershipWhereInput = { spaceId: sid, ...(userConds.length ? { user: { AND: userConds } } : {}) };

  const [matching, memberships] = await Promise.all([
    db.spaceMembership.count({ where }),
    db.spaceMembership.findMany({
      where,
      include: { user: { select: { id: true, name: true, matricNo: true, level: true, email: true } } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      ...(pageOpts ? { skip: pageOpts.skip, take: pageOpts.take } : {}),
    }),
  ]);

  const payments = memberships.length
    ? await db.duePayment.findMany({
        where: { dueId, userId: { in: memberships.map((m) => m.userId) } },
        select: { userId: true, paidAt: true, reference: true },
      })
    : [];
  const paymentByUser = new Map(payments.map((p) => [p.userId, p]));

  const students = memberships.map((m) => {
    const payment = paymentByUser.get(m.userId);
    return {
      id: m.user.id,
      name: m.user.name,
      matricNo: m.user.matricNo,
      level: m.user.level,
      email: m.user.email,
      status: payment ? ('paid' as const) : ('unpaid' as const),
      paidAt: payment ? payment.paidAt.toISOString() : null,
      reference: payment ? payment.reference : null,
    };
  });

  return { matching, students };
}

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/collections — per-student roster + totals (§7.6)
// ---------------------------------------------------------------------------
const collectionsQuery = z.object({
  status: z.enum(['all', 'paid', 'unpaid']).default('all'),
});

repDuesRouter.get('/dues/:dueId/collections', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }

  const parsed = collectionsQuery.safeParse(req.query);
  const statusFilter = parsed.success ? parsed.data.status : 'all';
  const { page, perPage, skip, take, q } = parseListQuery(req);

  const [{ matching, students }, memberCount, agg] = await Promise.all([
    buildRoster(sid, due.id, statusFilter, q, { skip, take }),
    db.spaceMembership.count({ where: { spaceId: sid } }),
    db.duePayment.aggregate({
      where: { dueId: due.id },
      _count: { _all: true },
      _sum: { amountPaid: true, processingFee: true, duevyFee: true, netToSpace: true },
    }),
  ]);

  const paidCount = agg._count._all;
  const collected = agg._sum.amountPaid ?? 0;
  const fees = (agg._sum.processingFee ?? 0) + (agg._sum.duevyFee ?? 0);
  const net = agg._sum.netToSpace ?? 0;
  // Expected is the gross the space would collect if every member paid.
  const expected = computeCharge(due.amount).total * memberCount;

  ok(
    res,
    {
      totals: {
        paid: paidCount,
        unpaid: Math.max(0, memberCount - paidCount),
        collected,
        fees,
        net,
        expected,
        rate: expected > 0 ? collected / expected : 0,
      },
      students,
    },
    200,
    buildMeta(page, perPage, matching),
  );
});

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/collections/export — CSV roster (§7.8)
// ---------------------------------------------------------------------------
function csvCell(value: string | null): string {
  const v = value ?? '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

repDuesRouter.get('/dues/:dueId/collections/export', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }

  const parsed = collectionsQuery.safeParse(req.query);
  const statusFilter = parsed.success ? parsed.data.status : 'all';
  const { students } = await buildRoster(sid, due.id, statusFilter);

  const header = ['Name', 'Matric No', 'Level', 'Email', 'Status', 'Paid At', 'Reference'];
  const rows = students.map((s) =>
    [s.name, s.matricNo, s.level, s.email, s.status, s.paidAt, s.reference].map(csvCell).join(','),
  );
  const csv = [header.join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="collections-${due.id}.csv"`);
  res.status(200).send(csv);
});

// ---------------------------------------------------------------------------
// POST /dues/{dueId}/remind — nudge unpaid members (§7.7)
// ---------------------------------------------------------------------------
const remindSchema = z.object({ userIds: z.array(z.string()).max(500).optional() });

const REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

repDuesRouter.post('/dues/:dueId/remind', validate(remindSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { userIds } = req.body as z.infer<typeof remindSchema>;

  const due = await loadDue(sid, req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }

  // One blast per due per 24h. Claim the slot atomically before notifying so
  // two concurrent requests can't both pass the cooldown check.
  const claim = await db.due.updateMany({
    where: {
      id: due.id,
      OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: new Date(Date.now() - REMIND_COOLDOWN_MS) } }],
    },
    data: { lastRemindedAt: new Date() },
  });
  if (claim.count === 0) {
    fail(res, 429, 'REMINDER_COOLDOWN', 'This due was already reminded within the last 24 hours');
    return;
  }

  // Unpaid members, optionally narrowed to the given users.
  const memberships = await db.spaceMembership.findMany({
    where: {
      spaceId: sid,
      ...(userIds && userIds.length ? { userId: { in: userIds } } : {}),
      user: { duePayments: { none: { dueId: due.id } } },
    },
    select: { userId: true },
  });
  const targets = memberships.map((m) => m.userId);

  const count = await notifyMany(targets, {
    kind: 'due_reminder',
    tone: 'amber',
    title: `Reminder: ${due.title}`,
    detail: `You have an outstanding due of ₦${(due.amount / 100).toLocaleString('en-NG')}.`,
    href: '/dashboard/dues',
  });

  ok(res, { reminded: count });
});

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma, type RepRole } from '@prisma/client';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeRepDue } from '../lib/serializers';
import { generateId } from '../lib/id';
import { renderDuePoster } from '../lib/poster';
import { requestRefund } from '../services/refund.service';
import { env } from '../config/env';
import { DUE_TYPES } from '../lib/dueTypes';
import { DEFAULT_GUEST_FIELDS, guestFieldsSchema, readGuestAnswers, readGuestFields } from '../lib/guestForm';
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

/**
 * Who counts as a guest payer: anyone who isn't a member of the space — by
 * membership, not account type, so a guest who later activates an account (or
 * a signed-in non-member paying through the link) stays out of the members'
 * paid / unpaid, and someone who joins the space afterwards moves into it.
 */
const paidByMember = (spaceId: string) => ({ user: { spaceMemberships: { some: { spaceId } } } });
const paidByOutsider = (spaceId: string) => ({ user: { spaceMemberships: { none: { spaceId } } } });

async function repDuePayload(sid: string, due: Awaited<ReturnType<typeof loadDue>>) {
  if (!due) throw new Error('due required');
  const [paidCount, guestPaidCount, memberCount] = await Promise.all([
    db.duePayment.count({ where: { dueId: due.id, ...paidByMember(sid) } }),
    db.duePayment.count({ where: { dueId: due.id, ...paidByOutsider(sid) } }),
    db.spaceMembership.count({ where: { spaceId: sid } }),
  ]);
  return serializeRepDue(due, { paidCount, guestPaidCount, memberCount });
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

  // One round trip: the counts filter by the same due criteria as a relation
  // instead of waiting for the due list to collect its ids.
  const dueWhere = { spaceId: sid, ...(status ? { status } : {}), ...(category ? { category } : {}) };
  const [dues, memberCount, paidCounts, guestCounts] = await Promise.all([
    // id breaks createdAt ties, so the order is the same on every request.
    db.due.findMany({ where: dueWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    db.spaceMembership.count({ where: { spaceId: sid } }),
    // Paid counts are members only (they're compared with memberCount); guest
    // payments are counted on their own.
    db.duePayment.groupBy({
      by: ['dueId'],
      where: { due: dueWhere, ...paidByMember(sid) },
      _count: { _all: true },
    }),
    db.duePayment.groupBy({
      by: ['dueId'],
      where: { due: dueWhere, ...paidByOutsider(sid) },
      _count: { _all: true },
    }),
  ]);
  const paidByDue = new Map(paidCounts.map((p) => [p.dueId, p._count._all]));
  const guestsByDue = new Map(guestCounts.map((p) => [p.dueId, p._count._all]));

  ok(
    res,
    dues.map((d) =>
      serializeRepDue(d, {
        paidCount: paidByDue.get(d.id) ?? 0,
        guestPaidCount: guestsByDue.get(d.id) ?? 0,
        memberCount,
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// POST /dues — create a due (§7.2)
// ---------------------------------------------------------------------------
const createDueSchema = z.object({
  title: z.string().min(3).max(120),
  note: z.string().max(500).optional(),
  amount: z.number().int().positive().max(MAX_DUE_AMOUNT_KOBO),
  // Optional: a due can have no deadline. When given it must be today or later.
  dueDate: dueDateField
    .refine((s) => {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      return new Date(`${s}T00:00:00Z`) >= today;
    }, 'must be today or later')
    .nullish(),
  category: categoryField,
  // Who pays the 1.5% processing fee: `student` (on top, the default) or
  // `space` (absorbed — the space collects the amount less the fee).
  feePayer: z.enum(['student', 'space']).default('student'),
  publish: z.boolean().default(false),
  // Lead only: the co-rep who can withdraw this due's collections. Defaults to the creator.
  assignedRepId: z.string().min(1).optional(),
  // Opens the due's public pay link to people outside the space (no account).
  allowGuests: z.boolean().default(true),
  // Extra questions on the guest pay link. Omitted = DEFAULT_GUEST_FIELDS; null = the original form.
  guestFields: guestFieldsSchema.optional(),
});

repDuesRouter.post('/dues', typeAlias, validate(createDueSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const data = req.body as z.infer<typeof createDueSchema>;
  const publishing = data.publish;

  // Assigning to someone else is the lead's call, and only to a co-rep.
  const me = uid(req);
  const assignee = data.assignedRepId ?? me;
  let assigneeName: string | null = null;
  if (assignee !== me) {
    if ((req as AuthenticatedRequest).spaceRep?.role !== 'lead') {
      errors.forbidden(res, 'Only the lead rep can assign a due to someone else');
      return;
    }
    const target = await db.spaceRep.findUnique({
      where: { userId_spaceId: { userId: assignee, spaceId: sid } },
      include: { user: { select: { name: true } } },
    });
    if (!target || target.role !== 'co') {
      errors.validation(res, [{ field: 'assignedRepId', issue: 'must be an existing co-rep of this space' }]);
      return;
    }
    assigneeName = target.user.name;
  }

  if (publishing && !(await assertCanCollect(sid, res))) return;

  const due = await db.$transaction(async (tx) => {
    const created = await tx.due.create({
      data: {
        id: generateId('due'),
        spaceId: sid,
        title: data.title,
        note: data.note,
        amount: data.amount,
        dueDate: data.dueDate ? new Date(`${data.dueDate}T00:00:00Z`) : null,
        category: data.category,
        feePayer: data.feePayer,
        status: publishing ? 'active' : 'draft',
        publishedAt: publishing ? new Date() : null,
        assignedRepId: assignee,
        allowGuests: data.allowGuests,
        guestFields: data.guestFields === undefined ? DEFAULT_GUEST_FIELDS : (data.guestFields ?? Prisma.DbNull),
      },
    });
    if (publishing) {
      await writeAudit(sid, await actor(req),'due_published', `Published due "${created.title}"`, tx);
    }
    if (assigneeName) {
      await writeAudit(sid, await actor(req), 'due_reassigned', `Assigned due "${created.title}" to ${assigneeName}`, tx);
    }
    return created;
  });

  if (assigneeName) {
    await notify({
      userId: assignee,
      kind: 'system',
      title: 'A due was assigned to you',
      detail: `"${due.title}" is assigned to you — you can withdraw its collected funds.`,
      href: '/dashboard/dues',
    });
  }

  ok(res, await repDuePayload(sid, due), 201);
});

// ---------------------------------------------------------------------------
// PATCH /dues/{dueId} — edit a draft or active due (§7.3)
// ---------------------------------------------------------------------------
const patchDueSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  note: z.string().max(500).optional(),
  amount: z.number().int().positive().max(MAX_DUE_AMOUNT_KOBO).optional(),
  // `null` clears the deadline; a string sets it.
  dueDate: dueDateField.nullish(),
  category: categoryField.optional(),
  feePayer: z.enum(['student', 'space']).optional(),
  allowGuests: z.boolean().optional(),
  guestFields: guestFieldsSchema.optional(),
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

  // amount and feePayer are immutable once any payment exists: both are baked
  // into every settled checkout, so changing them would desync paid records.
  const changingAmount = data.amount !== undefined && data.amount !== due.amount;
  const changingFeePayer = data.feePayer !== undefined && data.feePayer !== due.feePayer;
  if (changingAmount || changingFeePayer) {
    const payments = await db.duePayment.count({ where: { dueId: due.id } });
    if (payments > 0) {
      const field = changingAmount ? 'Amount' : 'Who pays the processing fee';
      errors.conflict(res, 'DUE_HAS_PAYMENTS', `${field} cannot change after payments have been made`);
      return;
    }
  }

  const updated = await db.due.update({
    where: { id: due.id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.dueDate !== undefined ? { dueDate: data.dueDate ? new Date(`${data.dueDate}T00:00:00Z`) : null } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.feePayer !== undefined ? { feePayer: data.feePayer } : {}),
      ...(data.allowGuests !== undefined ? { allowGuests: data.allowGuests } : {}),
      ...(data.guestFields !== undefined ? { guestFields: data.guestFields ?? Prisma.DbNull } : {}),
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

/** People outside the space who paid this due through its guest link. */
async function guestPayers(sid: string, dueId: string) {
  const rows = await db.duePayment.findMany({
    where: { dueId, ...paidByOutsider(sid) },
    include: {
      user: { select: { id: true, name: true, email: true, matricNo: true } },
      checkout: { select: { guestAnswers: true, senderAccountNumber: true, senderBank: true } },
    },
    orderBy: { paidAt: 'desc' },
    take: 500,
  });
  const refunded = await refundedByPayment(rows.map((p) => p.id));
  return rows.map((p) => ({
    id: p.user.id,
    name: p.user.name,
    email: p.user.email,
    matricNo: p.user.matricNo,
    paidAt: p.paidAt.toISOString(),
    reference: p.reference,
    answers: readGuestAnswers(p.checkout?.guestAnswers),
    ...refundFields(p, refunded.get(p.id) ?? 0),
  }));
}

/** Sum of refunds already issued or in flight, per payment. */
async function refundedByPayment(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const sums = await db.refund.groupBy({
    by: ['duePaymentId'],
    where: { duePaymentId: { in: ids }, status: { in: ['pending', 'processing', 'success'] } },
    _sum: { amountKobo: true },
  });
  return new Map(sums.map((s) => [s.duePaymentId, s._sum.amountKobo ?? 0]));
}

/** The refund state of one payment, for a roster row. */
function refundFields(
  p: { id: string; amountPaid: number; checkout: { senderAccountNumber: string | null; senderBank: string | null } | null },
  refundedKobo: number,
) {
  const canRefund = !!p.checkout?.senderAccountNumber;
  return {
    duePaymentId: p.id,
    amountPaid: p.amountPaid,
    refundedKobo,
    refundableKobo: Math.max(0, p.amountPaid - refundedKobo),
    canRefund,
    sourceAccount: canRefund ? `${p.checkout!.senderBank ?? 'Bank'} ••••${p.checkout!.senderAccountNumber!.slice(-4)}` : null,
  };
}

async function buildRoster(
  sid: string,
  dueId: string,
  filter: RosterStatus,
  q?: string,
  pageOpts?: { skip: number; take: number },
) {
  // Filter and paginate memberships in the DB; each member's payment for the
  // due comes back in the same statement.
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

  // One round trip: each member's payment for this due rides along in the
  // same statement (relationJoins) instead of a second query after the page.
  const [matching, memberships] = await Promise.all([
    db.spaceMembership.count({ where }),
    db.spaceMembership.findMany({
      where,
      include: {
        user: {
          select: {
            id: true, name: true, matricNo: true, level: true, email: true,
            duePayments: {
              where: { dueId },
              select: {
                id: true,
                paidAt: true,
                reference: true,
                amountPaid: true,
                checkout: { select: { senderAccountNumber: true, senderBank: true } },
              },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      ...(pageOpts ? { skip: pageOpts.skip, take: pageOpts.take } : {}),
    }),
  ]);

  const paidIds = memberships.map((m) => m.user.duePayments[0]?.id).filter((x): x is string => !!x);
  const refunded = await refundedByPayment(paidIds);

  const students = memberships.map((m) => {
    const payment = m.user.duePayments[0];
    return {
      id: m.user.id,
      name: m.user.name,
      matricNo: m.user.matricNo,
      level: m.user.level,
      email: m.user.email,
      status: payment ? ('paid' as const) : ('unpaid' as const),
      paidAt: payment ? payment.paidAt.toISOString() : null,
      reference: payment ? payment.reference : null,
      ...(payment ? refundFields(payment, refunded.get(payment.id) ?? 0) : {}),
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
  const dueId = req.params.dueId as string;

  const parsed = collectionsQuery.safeParse(req.query);
  const statusFilter = parsed.success ? parsed.data.status : 'all';
  const { page, perPage, skip, take, q } = parseListQuery(req);

  // Everything in one round trip. The due's ownership check runs alongside
  // the reads, not before them: if the due isn't this space's, the results
  // are discarded and nothing but the 404 leaves.
  const [due, { matching, students }, agg, guests, paidCount] = await Promise.all([
    loadDue(sid, dueId),
    buildRoster(sid, dueId, statusFilter, q, { skip, take }),
    // Money totals include guests: that money really arrived.
    db.duePayment.aggregate({
      where: { dueId },
      _sum: { amountPaid: true, processingFee: true, duevyFee: true, netToSpace: true },
    }),
    guestPayers(sid, dueId),
    // Paid/unpaid compare against members, so guests are left out of them.
    db.duePayment.count({ where: { dueId, ...paidByMember(sid) } }),
  ]);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }
  const collected = agg._sum.amountPaid ?? 0;
  const fees = (agg._sum.processingFee ?? 0) + (agg._sum.duevyFee ?? 0);
  const net = agg._sum.netToSpace ?? 0;

  ok(
    res,
    {
      totals: {
        paid: paidCount,
        collected,
        fees,
        net,
        guestPaid: guests.length,
      },
      students,
      guests,
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
  const [{ students }, guests] = await Promise.all([
    buildRoster(sid, due.id, statusFilter),
    statusFilter === 'unpaid' ? Promise.resolve([]) : guestPayers(sid, due.id),
  ]);

  // A column per guest question: the due's current fields, then any that were
  // answered before being removed. Members leave them blank.
  const questions = new Map((readGuestFields(due.guestFields) ?? []).map((f) => [f.id, f.label]));
  for (const g of guests) for (const a of g.answers) if (!questions.has(a.fieldId)) questions.set(a.fieldId, a.label);
  const questionIds = [...questions.keys()];
  const blanks = questionIds.map(() => null);

  const header = ['Name', 'Matric No', 'Level', 'Email', 'Status', 'Paid At', 'Reference', ...questions.values()];
  const rows = [
    ...students.map((s) =>
      [s.name, s.matricNo, s.level, s.email, s.status, s.paidAt, s.reference, ...blanks].map(csvCell).join(','),
    ),
    ...guests.map((g) => {
      const answers = questionIds.map((id) => g.answers.find((a) => a.fieldId === id)?.value ?? null);
      return [g.name, g.matricNo, null, g.email, 'paid', g.paidAt, g.reference, ...answers].map(csvCell).join(',');
    }),
  ];
  const csv = [header.join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="collections-${due.id}.csv"`);
  res.status(200).send(csv);
});

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/poster — a printable "scan to pay" QR poster for the due's
// public pay link. Rep prints it and puts it up; guests scan it to pay.
// ---------------------------------------------------------------------------
repDuesRouter.get('/dues/:dueId/poster', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await db.due.findUnique({
    where: { id: req.params.dueId as string },
    include: { space: { select: { name: true } } },
  });
  if (!due || due.spaceId !== sid) {
    errors.notFound(res, 'Due not found');
    return;
  }
  // The poster carries the guest pay link, which only exists for a published,
  // guest-enabled due. Anything else has no link to put on a wall.
  if (due.status !== 'active' || !due.allowGuests) {
    fail(res, 409, 'POSTER_UNAVAILABLE', 'A poster is only available once the due is published with its pay link on.');
    return;
  }

  const payUrl = `${env.FRONTEND_URL}/pay/${encodeURIComponent(due.id)}`;
  const deadline = due.dueDate?.toLocaleDateString('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
  const pdf = await renderDuePoster({
    spaceName: due.space.name,
    dueTitle: due.title,
    amountKobo: due.amount,
    deadline,
    payUrl,
  });

  const slug = due.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'due';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-poster.pdf"`);
  res.status(200).send(pdf);
});

// ---------------------------------------------------------------------------
// POST /dues/{dueId}/payments/{duePaymentId}/refund — send a payer's money
// back to the account they paid from. Lead only; asks for the withdrawal code.
// ---------------------------------------------------------------------------
const refundSchema = z.object({
  amountKobo: z.number().int().positive(),
  pin: z.string().min(1).max(32),
  reason: z.string().max(300).optional(),
});

repDuesRouter.post(
  '/dues/:dueId/payments/:duePaymentId/refund',
  requireSpaceRep(true),
  validate(refundSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof refundSchema>;
    const refund = await requestRefund({
      spaceId: spaceId(req),
      dueId: req.params.dueId as string,
      duePaymentId: req.params.duePaymentId as string,
      requestedById: uid(req),
      amountKobo: body.amountKobo,
      pin: body.pin,
      reason: body.reason,
    });
    ok(
      res,
      {
        id: refund.id,
        reference: refund.reference,
        status: refund.status,
        amountKobo: refund.amountKobo,
        accountMasked: refund.accountMasked,
        createdAt: refund.createdAt.toISOString(),
      },
      201,
    );
  },
);

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

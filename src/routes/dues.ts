import { type Prisma } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { checkoutLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { computeChargeFor, feeBpsForSpace } from '../lib/money';
import { DUE_TYPES } from '../lib/dueTypes';
import { createCheckout } from '../services/checkout.service';
import { renderDueReceipt } from '../services/receipt.service';
import { type Due, type DuePayment, type DueTier } from '@prisma/client';

export const duesRouter = Router();
duesRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

type ViewerStatus = 'unpaid' | 'paid' | 'overdue';

function viewerStatus(due: Due, payment: DuePayment | undefined, now: Date): ViewerStatus {
  if (payment) return 'paid';
  // A due with no deadline is never overdue.
  if (due.dueDate && due.dueDate < now) return 'overdue';
  return 'unpaid';
}

/**
 * A due as the student sees it. `processingFee`/`payableAmount` are what this
 * due would cost on its own; a multi-due checkout charges the ₦20 flat once,
 * so its total is less than the sum of these.
 */
function serializeStudentDue(
  due: Due & { tiers?: DueTier[]; space?: { collectionFeeBps: number | null } },
  payment: DuePayment | undefined,
  now: Date,
) {
  const studentBears = due.feePayer === 'student';
  // The space's rate (its override or the default) so the preview matches what
  // checkout will actually charge.
  const feeBps = feeBpsForSpace(due.space ?? {});
  // A space-borne fee isn't charged to the student: they pay only the face.
  const charge = computeChargeFor(due.amount, studentBears, feeBps);
  const tiered = due.pricingMode === 'tiered';
  return {
    id: due.id,
    spaceId: due.spaceId,
    title: due.title,
    note: due.note,
    pricingMode: due.pricingMode,
    // Flat due: one amount. Tiered due: the payer picks a tier (amounts null).
    amount: tiered ? null : due.amount, // face amount the rep set
    processingFee: tiered ? null : charge.fee, // 1.5% added on top, or 0 when the space absorbs it
    payableAmount: tiered ? null : charge.total, // what the student pays for this due alone
    tiers: tiered
      ? (due.tiers ?? []).map((t) => {
          const c = computeChargeFor(t.amountKobo, studentBears, feeBps);
          return { id: t.id, label: t.label, amount: t.amountKobo, processingFee: c.fee, payableAmount: c.total };
        })
      : [],
    feePayer: due.feePayer,
    dueDate: due.dueDate ? due.dueDate.toISOString().slice(0, 10) : null,
    type: due.category,
    category: due.category, // deprecated alias of `type`
    status: viewerStatus(due, payment, now),
    paidAt: payment ? payment.paidAt.toISOString() : null,
    reference: payment ? payment.reference : null,
  };
}

// ---------------------------------------------------------------------------
// GET /dues — all of the caller's dues across their spaces (§6.1)
// ---------------------------------------------------------------------------
const listQuery = z.object({
  spaceId: z.string().optional(),
  status: z.enum(['unpaid', 'paid', 'overdue']).optional(),
  type: z.enum(DUE_TYPES).optional(),
  category: z.enum(DUE_TYPES).optional(),
});

duesRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    errors.validation(res, parsed.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const filters = parsed.data;
  const type = filters.type ?? filters.category;
  const { page, perPage, skip, take } = parseListQuery(req);
  const now = new Date();

  // The viewer status is derived from payment + deadline, so it maps onto a
  // DB filter and pagination can happen in the query. Membership is a relation
  // filter and the viewer's payment rides along in the same statement, so the
  // whole page is one round trip.
  const statusWhere =
    filters.status === 'paid'
      ? { payments: { some: { userId: id } } }
      : filters.status === 'unpaid'
        ? // Not overdue: still open (deadline ahead) or without a deadline at all.
          { payments: { none: { userId: id } }, OR: [{ dueDate: { gte: now } }, { dueDate: null }] }
        : filters.status === 'overdue'
          ? { payments: { none: { userId: id } }, dueDate: { lt: now } }
          : {};
  const where: Prisma.DueWhereInput = {
    space: { memberships: { some: { userId: id } } },
    ...(filters.spaceId ? { spaceId: filters.spaceId } : {}),
    status: { in: ['active', 'closed'] },
    ...(type ? { category: type } : {}),
    ...statusWhere,
  };

  const [total, dues] = await Promise.all([
    db.due.count({ where }),
    db.due.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      skip,
      take,
      include: {
        payments: { where: { userId: id }, take: 1 },
        tiers: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' } },
        space: { select: { collectionFeeBps: true } },
      },
    }),
  ]);
  const paymentByDue = new Map(dues.flatMap((d) => (d.payments[0] ? [[d.id, d.payments[0]] as const] : [])));

  const items = dues.map((d) => serializeStudentDue(d, paymentByDue.get(d.id), now));
  ok(res, items, 200, buildMeta(page, perPage, total));
});

// ---------------------------------------------------------------------------
// GET /dues/{dueId} — single due with viewer state (§6.2). Members only.
// ---------------------------------------------------------------------------
duesRouter.get('/:dueId', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const due = await db.due.findUnique({
    where: { id: req.params.dueId as string },
    include: {
      tiers: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' } },
      space: { select: { collectionFeeBps: true } },
    },
  });
  if (!due || due.status === 'draft') {
    errors.notFound(res, 'Due not found');
    return;
  }
  const member = await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId: id, spaceId: due.spaceId } } });
  if (!member) {
    fail(res, 403, 'NOT_A_MEMBER', 'You are not a member of this space');
    return;
  }
  const payment = await db.duePayment.findUnique({ where: { userId_dueId: { userId: id, dueId: due.id } } });
  ok(res, serializeStudentDue(due, payment ?? undefined, new Date()));
});

// ---------------------------------------------------------------------------
// Checkout — one bank transfer settling one or more dues (Idempotency-Key required)
//
// The body names dues only. Every amount (face, fee, total) is computed on the
// server from the dues themselves; nothing about money is read from the client.
// ---------------------------------------------------------------------------
const payManySchema = z
  .object({
    dueIds: z.array(z.string().min(1)).min(1).max(20),
    // For any tiered due in the basket, the chosen tier, keyed by due id.
    tierSelections: z.record(z.string().min(1)).optional(),
    // Bank transfer is the only method; accepted so older clients keep working.
    method: z.literal('online').optional(),
  })
  .strict();

const paySingleSchema = z
  .object({ method: z.literal('online').optional(), tierId: z.string().min(1).optional() })
  .strict();

async function startCheckout(
  req: Request,
  res: Response,
  dueIds: string[],
  tierSelections?: Record<string, string>,
): Promise<void> {
  const { checkout, reused } = await createCheckout(uid(req), dueIds, tierSelections ? { tierSelections } : {});
  ok(res, { ...checkout, reused }, reused ? 200 : 201);
}

// POST /dues/pay — several dues, one transfer
duesRouter.post(
  '/pay',
  checkoutLimiter,
  requireIdempotencyKey,
  idempotent,
  validate(payManySchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof payManySchema>;
    await startCheckout(req, res, body.dueIds, body.tierSelections);
  },
);

// POST /dues/{dueId}/pay — a basket of one
duesRouter.post(
  '/:dueId/pay',
  checkoutLimiter,
  requireIdempotencyKey,
  idempotent,
  validate(paySingleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const dueId = req.params.dueId as string;
    const { tierId } = req.body as z.infer<typeof paySingleSchema>;
    await startCheckout(req, res, [dueId], tierId ? { [dueId]: tierId } : undefined);
  },
);

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/receipt — the PDF receipt for this due: just its line when
// it was paid together with other dues (the full receipt is /receipts/:number)
// ---------------------------------------------------------------------------
duesRouter.get('/:dueId/receipt', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const payment = await db.duePayment.findUnique({
    where: { userId_dueId: { userId: id, dueId: req.params.dueId as string } },
    select: { checkoutId: true },
  });
  if (!payment?.checkoutId) {
    errors.notFound(res, 'No receipt — this due has not been paid through Duevy checkout');
    return;
  }
  const { filename, pdf } = await renderDueReceipt(payment.checkoutId, req.params.dueId as string, id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.status(200).send(pdf);
});

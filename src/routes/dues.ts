import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { checkoutLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { computeCharge } from '../lib/money';
import { DUE_TYPES } from '../lib/dueTypes';
import { createCheckout } from '../services/checkout.service';
import { renderCheckoutReceipt } from '../services/receipt.service';
import { type Due, type DuePayment } from '@prisma/client';

export const duesRouter = Router();
duesRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

type ViewerStatus = 'unpaid' | 'paid' | 'overdue';

function viewerStatus(due: Due, payment: DuePayment | undefined, now: Date): ViewerStatus {
  if (payment) return 'paid';
  if (due.dueDate < now) return 'overdue';
  return 'unpaid';
}

/**
 * A due as the student sees it. `processingFee`/`payableAmount` are what this
 * due would cost on its own; a multi-due checkout charges the ₦20 flat once,
 * so its total is less than the sum of these.
 */
function serializeStudentDue(due: Due, payment: DuePayment | undefined, now: Date) {
  const charge = computeCharge(due.amount);
  return {
    id: due.id,
    spaceId: due.spaceId,
    title: due.title,
    note: due.note,
    amount: due.amount, // face amount the rep set
    processingFee: charge.fee, // 2% + ₦20, added on top
    payableAmount: charge.total, // what the student pays for this due alone
    dueDate: due.dueDate.toISOString().slice(0, 10),
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

  const memberships = await db.spaceMembership.findMany({ where: { userId: id }, select: { spaceId: true } });
  let spaceIds = memberships.map((m) => m.spaceId);
  if (filters.spaceId) spaceIds = spaceIds.filter((s) => s === filters.spaceId);

  if (spaceIds.length === 0) {
    ok(res, [], 200, buildMeta(page, perPage, 0));
    return;
  }

  const dues = await db.due.findMany({
    where: {
      spaceId: { in: spaceIds },
      status: { in: ['active', 'closed'] },
      ...(type ? { category: type } : {}),
    },
    orderBy: { dueDate: 'asc' },
  });

  const payments = await db.duePayment.findMany({ where: { userId: id, dueId: { in: dues.map((d) => d.id) } } });
  const paymentByDue = new Map(payments.map((p) => [p.dueId, p]));

  let items = dues.map((d) => serializeStudentDue(d, paymentByDue.get(d.id), now));
  if (filters.status) items = items.filter((d) => d.status === filters.status);

  ok(res, items.slice(skip, skip + take), 200, buildMeta(page, perPage, items.length));
});

// ---------------------------------------------------------------------------
// GET /dues/{dueId} — single due with viewer state (§6.2). Members only.
// ---------------------------------------------------------------------------
duesRouter.get('/:dueId', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const due = await db.due.findUnique({ where: { id: req.params.dueId as string } });
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
    // Bank transfer is the only method; accepted so older clients keep working.
    method: z.literal('online').optional(),
  })
  .strict();

const paySingleSchema = z.object({ method: z.literal('online').optional() }).strict();

async function startCheckout(req: Request, res: Response, dueIds: string[]): Promise<void> {
  const { checkout, reused } = await createCheckout(uid(req), dueIds);
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
    await startCheckout(req, res, (req.body as z.infer<typeof payManySchema>).dueIds);
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
    await startCheckout(req, res, [req.params.dueId as string]);
  },
);

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/receipt — the PDF receipt of the payment that settled it
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
  const { filename, pdf } = await renderCheckoutReceipt(payment.checkoutId, id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.status(200).send(pdf);
});

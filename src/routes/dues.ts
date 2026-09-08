import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { computeCharge } from '../lib/money';
import { KycNotVerifiedError } from '../services/anchorCustomer.service';
import { renderReceiptPdf } from '../lib/receipt';
import { initOnlineDuePayment } from '../services/payment.service';
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

function serializeStudentDue(due: Due, payment: DuePayment | undefined, now: Date) {
  const charge = computeCharge(due.amount);
  return {
    id: due.id,
    spaceId: due.spaceId,
    title: due.title,
    note: due.note,
    amount: due.amount, // face amount the rep set
    processingFee: charge.totalFee, // the 2% service charge, added on top
    payableAmount: charge.totalCharged, // what the student actually pays
    dueDate: due.dueDate.toISOString().slice(0, 10),
    category: due.category,
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
  category: z.enum(['levy', 'dinner', 'handout', 'welfare', 'sport']).optional(),
});

duesRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    errors.validation(res, parsed.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const filters = parsed.data;
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
      ...(filters.category ? { category: filters.category } : {}),
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
// GET /dues/{dueId} — single due with viewer state (§6.2)
// ---------------------------------------------------------------------------
async function loadDueForViewer(dueId: string, userId: string) {
  const due = await db.due.findUnique({ where: { id: dueId } });
  if (!due) return { due: null as Due | null, member: false };
  const member = !!(await db.spaceMembership.findUnique({
    where: { userId_spaceId: { userId, spaceId: due.spaceId } },
  }));
  return { due, member };
}

duesRouter.get('/:dueId', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const { due, member } = await loadDueForViewer(req.params.dueId as string, id);
  if (!due) {
    errors.notFound(res, 'Due not found');
    return;
  }
  if (!member && !due.allowGuests) {
    fail(res, 403, 'NOT_A_MEMBER', 'You are not a member of this space');
    return;
  }
  const payment = await db.duePayment.findUnique({ where: { userId_dueId: { userId: id, dueId: due.id } } });
  ok(res, serializeStudentDue(due, payment ?? undefined, new Date()));
});

// ---------------------------------------------------------------------------
// POST /dues/{dueId}/pay — settle a due (§6.3) — Idempotency-Key required
// ---------------------------------------------------------------------------
const paySchema = z.object({
  method: z.enum(['online']),
  // Referral reward, redeemable only by its owner against one of their own dues.
  discountCode: z.string().optional(),
});

/** Multi-due checkout (PRD §5.2) — the student ticks several dues and pays once. */
const payManySchema = paySchema.extend({
  dueIds: z.array(z.string().min(1)).min(1).max(20),
});

type CheckoutRejection = { status: number; code: string; message: string };

/**
 * Validate a basket of dues for one payer: all payable, all in one space, none
 * already settled. Returns either the dues in the order requested, or the first
 * reason the checkout cannot proceed.
 */
async function resolveBasket(
  userId: string,
  dueIds: string[],
): Promise<{ dues: (Due & { space: { name: string } })[] } | { error: CheckoutRejection }> {
  const dues = await db.due.findMany({
    where: { id: { in: dueIds } },
    include: { space: { select: { name: true } } },
  });
  if (dues.length !== dueIds.length) {
    return { error: { status: 404, code: 'NOT_FOUND', message: 'One or more dues could not be found' } };
  }

  const notPayable = dues.find((d) => d.status !== 'active');
  if (notPayable) {
    return { error: { status: 409, code: 'DUE_NOT_PAYABLE', message: `"${notPayable.title}" is not open for payment` } };
  }

  // One checkout produces one transfer into one space's balance, so a basket
  // spanning two spaces cannot be settled by a single payment.
  const spaceIds = new Set(dues.map((d) => d.spaceId));
  if (spaceIds.size > 1) {
    return { error: { status: 422, code: 'MIXED_SPACES', message: 'Dues from different spaces must be paid separately' } };
  }

  const spaceId = dues[0].spaceId;
  const member = await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId, spaceId } } });
  if (!member && dues.some((d) => !d.allowGuests)) {
    return { error: { status: 403, code: 'NOT_A_MEMBER', message: 'You are not a member of this space' } };
  }

  const settled = await db.duePayment.findMany({
    where: { userId, dueId: { in: dues.map((d) => d.id) } },
    select: { dueId: true },
  });
  if (settled.length) {
    const paid = dues.find((d) => settled.some((p) => p.dueId === d.id));
    return {
      error: { status: 409, code: 'DUE_ALREADY_PAID', message: `"${paid?.title}" has already been settled` },
    };
  }

  const order = new Map(dueIds.map((id, i) => [id, i]));
  dues.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { dues };
}

async function startCheckout(req: Request, res: Response, dueIds: string[]): Promise<void> {
  const id = uid(req);
  const { discountCode } = req.body as z.infer<typeof paySchema>;

  const basket = await resolveBasket(id, dueIds);
  if ('error' in basket) {
    fail(res, basket.error.status, basket.error.code, basket.error.message);
    return;
  }

  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }

  // A referral discount is redeemed against ONE due — the first in the basket —
  // not spread across it, so the recorded per-due amounts stay reconcilable.
  let discount: { id: string; amountKobo: number; dueId: string } | undefined;
  if (discountCode) {
    const code = await db.discountCode.findUnique({ where: { code: discountCode } });
    if (!code || code.userId !== id || code.redeemedAt) {
      fail(res, 422, 'DISCOUNT_CODE_INVALID', 'This discount code is invalid, already used, or not yours');
      return;
    }
    discount = { id: code.id, amountKobo: code.amountKobo, dueId: basket.dues[0].id };
  }

  try {
    ok(res, await initOnlineDuePayment(user, basket.dues, discount));
  } catch (err) {
    if (err instanceof KycNotVerifiedError) {
      errors.conflict(res, 'SPACE_NOT_VERIFIED', err.message);
      return;
    }
    throw err;
  }
}

// POST /dues/pay — one transfer settling several dues (PRD §5.2)
duesRouter.post(
  '/pay',
  requireIdempotencyKey,
  idempotent,
  validate(payManySchema),
  async (req: Request, res: Response): Promise<void> => {
    await startCheckout(req, res, (req.body as z.infer<typeof payManySchema>).dueIds);
  },
);

// POST /dues/{dueId}/pay — single due. Kept so existing clients keep working;
// it is the same checkout with a basket of one.
duesRouter.post(
  '/:dueId/pay',
  requireIdempotencyKey,
  idempotent,
  validate(paySchema),
  async (req: Request, res: Response): Promise<void> => {
    await startCheckout(req, res, [req.params.dueId as string]);
  },
);

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/receipt — receipt for a settled due (§6.5)
// ---------------------------------------------------------------------------
duesRouter.get('/:dueId/receipt', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const dueId = req.params.dueId as string;

  const payment = await db.duePayment.findUnique({
    where: { userId_dueId: { userId: id, dueId } },
    include: {
      due: { include: { space: { select: { name: true } } } },
      user: { select: { name: true } },
      transaction: { select: { method: true } },
    },
  });
  if (!payment) {
    errors.notFound(res, 'No receipt — this due has not been paid');
    return;
  }

  // A checkout can settle several dues under one reference (PRD §5.2), so the
  // receipt covers the whole payment, not just the due it was opened from.
  const siblings = await db.duePayment.findMany({
    where: { reference: payment.reference, userId: id },
    include: { due: { select: { title: true } } },
    orderBy: { due: { title: 'asc' } },
  });
  const totals = siblings.reduce(
    (a, p) => ({
      amountPaid: a.amountPaid + p.amountPaid,
      processingFee: a.processingFee + p.processingFee,
      duevyFee: a.duevyFee + p.duevyFee,
      netToSpace: a.netToSpace + p.netToSpace,
    }),
    { amountPaid: 0, processingFee: 0, duevyFee: 0, netToSpace: 0 },
  );

  const pdf = await renderReceiptPdf({
    reference: payment.reference,
    title: siblings.length > 1 ? `${siblings.length} dues` : payment.due.title,
    lines: siblings.map((p) => ({ title: p.due.title, amountKobo: p.amountPaid })),
    spaceName: payment.due.space.name,
    payerName: payment.user.name,
    amountPaid: totals.amountPaid,
    processingFee: totals.processingFee,
    duevyFee: totals.duevyFee,
    netToSpace: totals.netToSpace,
    paidAt: payment.paidAt,
    method: payment.transaction?.method ?? 'Wallet',
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${payment.reference}.pdf"`);
  res.status(200).send(pdf);
});

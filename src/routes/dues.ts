import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeTransaction } from '../lib/serializers';
import { computeCharge } from '../lib/money';
import { renderReceiptHtml } from '../lib/receipt';
import {
  settleDueFromWallet,
  initOnlineDuePayment,
  InsufficientFundsError,
} from '../services/payment.service';
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
    processingFee: charge.totalFee, // 3% added on top
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
const paySchema = z
  .object({
    method: z.enum(['wallet', 'card', 'online']),
    cardId: z.string().optional(),
  })
  .refine((d) => d.method !== 'card' || !!d.cardId, { message: 'cardId is required for card payments', path: ['cardId'] });

duesRouter.post(
  '/:dueId/pay',
  requireIdempotencyKey,
  idempotent,
  validate(paySchema),
  async (req: Request, res: Response): Promise<void> => {
    const id = uid(req);
    const { method } = req.body as z.infer<typeof paySchema>;

    const due = await db.due.findUnique({
      where: { id: req.params.dueId as string },
      include: { space: { select: { name: true } } },
    });
    if (!due) {
      errors.notFound(res, 'Due not found');
      return;
    }
    if (due.status !== 'active') {
      errors.conflict(res, 'DUE_NOT_PAYABLE', 'This due is not open for payment');
      return;
    }

    const member = await db.spaceMembership.findUnique({
      where: { userId_spaceId: { userId: id, spaceId: due.spaceId } },
    });
    if (!member && !due.allowGuests) {
      fail(res, 403, 'NOT_A_MEMBER', 'You are not a member of this space');
      return;
    }

    const already = await db.duePayment.findUnique({ where: { userId_dueId: { userId: id, dueId: due.id } } });
    if (already) {
      errors.conflict(res, 'DUE_ALREADY_PAID', 'This due has already been settled');
      return;
    }

    if (method === 'card') {
      fail(res, 501, 'NOT_IMPLEMENTED', 'Saved-card charging is not available yet; use wallet or online.');
      return;
    }

    const user = await db.user.findUnique({ where: { id } });
    if (!user) {
      errors.notFound(res, 'User not found');
      return;
    }

    if (method === 'wallet') {
      try {
        const transaction = await settleDueFromWallet(user, due);
        ok(res, {
          transaction: serializeTransaction(transaction),
          receiptUrl: `${env.APP_BASE_URL}/v1/dues/${due.id}/receipt`,
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          fail(res, 402, 'INSUFFICIENT_FUNDS', 'Your wallet balance is too low for this payment');
          return;
        }
        throw err;
      }
      return;
    }

    // method === 'online'
    const result = await initOnlineDuePayment(user, due);
    ok(res, result);
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

  const html = renderReceiptHtml({
    reference: payment.reference,
    title: payment.due.title,
    spaceName: payment.due.space.name,
    payerName: payment.user.name,
    amountPaid: payment.amountPaid,
    monnifyFee: payment.monnifyFee,
    duevyFee: payment.duevyFee,
    netToSpace: payment.netToSpace,
    paidAt: payment.paidAt,
    method: payment.transaction?.method ?? 'Wallet',
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
});

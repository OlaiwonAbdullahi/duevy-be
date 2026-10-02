import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeTransaction } from '../lib/serializers';
import { renderReceiptPdf } from '../lib/receipt';
import { getCheckoutForUser } from '../services/checkout.service';
import { getReceiptByNumber, listReceipts, renderCheckoutReceipt, renderReceiptByNumber } from '../services/receipt.service';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// ---------------------------------------------------------------------------
// GET /transactions — the full ledger (§9.1)
// ---------------------------------------------------------------------------
const listQuery = z.object({
  direction: z.enum(['all', 'in', 'out']).default('all'),
  type: z.enum(['due', 'topup', 'referral', 'withdrawal', 'refund', 'vote']).optional(),
  status: z.enum(['completed', 'pending', 'failed']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

transactionsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    errors.validation(res, parsed.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const f = parsed.data;
  const { page, perPage, skip, take, q } = parseListQuery(req);

  const where: Prisma.TransactionWhereInput = { userId: id };
  if (f.type) where.type = f.type;
  if (f.status) where.status = f.status;
  if (f.direction === 'in') where.amount = { gt: 0 };
  if (f.direction === 'out') where.amount = { lt: 0 };
  if (f.from || f.to) {
    where.createdAt = {};
    if (f.from) where.createdAt.gte = new Date(f.from);
    if (f.to) where.createdAt.lte = new Date(f.to);
  }
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { reference: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  ok(res, rows.map(serializeTransaction), 200, buildMeta(page, perPage, total));
});

// ---------------------------------------------------------------------------
// GET /transactions/{id} (§9.2)
// ---------------------------------------------------------------------------
transactionsRouter.get('/:transactionId', async (req: Request, res: Response): Promise<void> => {
  const txn = await db.transaction.findFirst({
    where: { id: req.params.transactionId as string, userId: uid(req) },
  });
  if (!txn) {
    errors.notFound(res, 'Transaction not found');
    return;
  }
  ok(res, serializeTransaction(txn));
});

// ---------------------------------------------------------------------------
// GET /transactions/{id}/receipt (§9.3)
// ---------------------------------------------------------------------------
transactionsRouter.get('/:transactionId/receipt', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const txn = await db.transaction.findFirst({
    where: { id: req.params.transactionId as string, userId: id },
    include: {
      duePayment: { include: { due: { include: { space: { select: { name: true } } } } } },
      user: { select: { name: true } },
    },
  });
  if (!txn) {
    errors.notFound(res, 'Transaction not found');
    return;
  }

  // A checkout payment has a proper receipt; render that.
  const checkout = await db.checkout.findUnique({ where: { reference: txn.reference }, select: { id: true, status: true } });
  if (checkout) {
    if (checkout.status !== 'paid') {
      errors.notFound(res, 'No receipt — this payment has not completed');
      return;
    }
    const { filename, pdf } = await renderCheckoutReceipt(checkout.id, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.status(200).send(pdf);
    return;
  }

  // Legacy (pre-Bachs) transactions.
  const dp = txn.duePayment;
  const pdf = await renderReceiptPdf({
    reference: txn.reference,
    title: txn.title,
    spaceName: dp?.due.space.name ?? txn.detail ?? '',
    payerName: txn.user.name,
    amountPaid: dp?.amountPaid ?? Math.abs(txn.amount),
    processingFee: dp?.processingFee ?? 0,
    duevyFee: dp?.duevyFee ?? 0,
    netToSpace: dp?.netToSpace ?? Math.abs(txn.amount),
    paidAt: txn.createdAt,
    method: txn.method,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${txn.reference}.pdf"`);
  res.status(200).send(pdf);
});

// ---------------------------------------------------------------------------
// GET /payments/{reference} · /payments/{reference}/status — a checkout's
// state, for the "I've paid" screen. Mounted separately at /payments.
//
// Reads our own record only. The webhook (and the reconciliation job behind
// it) is what moves a checkout; a client poll never can.
// ---------------------------------------------------------------------------
export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

async function paymentStatus(req: Request, res: Response): Promise<void> {
  const id = uid(req);
  const reference = req.params.reference as string;

  const checkout = await db.checkout.findUnique({ where: { reference }, select: { userId: true } });
  if (checkout) {
    if (checkout.userId !== id) {
      errors.notFound(res, 'Payment not found');
      return;
    }
    const view = await getCheckoutForUser(reference, id);
    const txn = await db.transaction.findUnique({ where: { reference } });
    const receipt = view.status === 'paid' ? await db.receipt.findFirst({ where: { checkout: { reference } }, select: { number: true } }) : null;
    ok(res, {
      ...view,
      receiptNumber: receipt?.number ?? null,
      ...(txn && view.status === 'paid' ? { transaction: serializeTransaction(txn) } : {}),
    });
    return;
  }

  // Legacy (pre-Bachs) pending payments: report what we recorded.
  const pending = await db.pendingPayment.findUnique({ where: { reference } });
  if (!pending || pending.userId !== id) {
    errors.notFound(res, 'Payment not found');
    return;
  }
  ok(res, {
    reference,
    status: pending.status === 'completed' ? 'paid' : pending.status === 'failed' ? 'expired' : pending.status,
    checkoutUrl: null,
    bankTransfer: null,
  });
}

paymentsRouter.get('/:reference', paymentStatus);
paymentsRouter.get('/:reference/status', paymentStatus);

// ---------------------------------------------------------------------------
// GET /receipts · /receipts/{number} — the student's receipts. Mounted at /receipts.
// ?format=pdf on the single receipt returns the PDF.
// ---------------------------------------------------------------------------
export const receiptsRouter = Router();
receiptsRouter.use(authenticate);

receiptsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const { total, rows } = await listReceipts(uid(req), skip, take);
  ok(res, rows, 200, buildMeta(page, perPage, total));
});

receiptsRouter.get('/:number', async (req: Request, res: Response): Promise<void> => {
  const number = req.params.number as string;
  if (req.query.format === 'pdf') {
    const { filename, pdf } = await renderReceiptByNumber(number, uid(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.status(200).send(pdf);
    return;
  }
  ok(res, await getReceiptByNumber(number, uid(req)));
});

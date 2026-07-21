import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeTransaction } from '../lib/serializers';
import { renderReceiptPdf } from '../lib/receipt';
import { getTransactionStatus, getInvoiceStatus } from '../lib/paymentGateway';
import { fulfilByReference } from '../services/payment.service';

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

  const dp = txn.duePayment;
  const pdf = await renderReceiptPdf({
    reference: txn.reference,
    title: txn.title,
    spaceName: dp?.due.space.name ?? txn.detail ?? '',
    payerName: txn.user.name,
    amountPaid: dp?.amountPaid ?? Math.abs(txn.amount),
    monnifyFee: dp?.monnifyFee ?? 0,
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
// GET /payments/{reference}/status — poll a pending online payment (§6.4)
// Mounted separately at /payments.
// ---------------------------------------------------------------------------
export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

paymentsRouter.get('/:reference/status', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const reference = req.params.reference as string;

  let pending = await db.pendingPayment.findUnique({ where: { reference } });
  if (!pending || pending.userId !== id) {
    errors.notFound(res, 'Payment not found');
    return;
  }

  // "I've made payment" tap (§ in-app invoice flow) — actively check with the
  // gateway instead of just reading our own possibly-stale DB row, so the UI
  // can reflect success without waiting on the webhook round-trip. The
  // webhook remains the actual source of truth; fulfilByReference is
  // idempotent, so this racing with the webhook is safe by construction.
  if (pending.status === 'pending') {
    try {
      // due_payment/poll_vote always go through createInvoice() now — Monnify
      // needs its dedicated invoice-status endpoint for those (an
      // invoiceReference isn't a transactionReference); card_save is still a
      // plain init-transaction, so it keeps using getTransactionStatus.
      const live = pending.type === 'card_save' ? await getTransactionStatus(reference) : await getInvoiceStatus(reference);
      if (live?.paymentStatus === 'PAID') {
        await fulfilByReference(reference, true);
        pending = await db.pendingPayment.findUnique({ where: { reference } });
      } else if (live && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(live.paymentStatus)) {
        await fulfilByReference(reference, false);
        pending = await db.pendingPayment.findUnique({ where: { reference } });
      }
    } catch (err) {
      console.error(`[payments] status check failed for ref=${reference}:`, err);
    }
  }

  const status = pending?.status === 'completed' ? 'completed' : pending?.status === 'failed' ? 'failed' : 'pending';
  const txn = await db.transaction.findUnique({ where: { reference } });

  // Invoice details, snapshotted onto the PendingPayment at creation — lets a
  // dedicated payment page render the full invoice from just the reference
  // (e.g. on reload or the callback redirect landing), not only the session
  // that opened it. bankTransfer is only ever present for Monnify.
  const meta = pending?.metadata as
    | { amount?: number; checkoutUrl?: string; bankTransfer?: { accountNumber: string; bankName: string; accountName: string; expiresAt: string | null } | null }
    | undefined;

  ok(res, {
    status,
    ...(meta?.amount !== undefined ? { amount: meta.amount } : {}),
    ...(meta?.checkoutUrl ? { checkoutUrl: meta.checkoutUrl } : {}),
    ...(meta?.bankTransfer ? { bankTransfer: meta.bankTransfer } : {}),
    ...(txn && status === 'completed' ? { transaction: serializeTransaction(txn) } : {}),
  });
});

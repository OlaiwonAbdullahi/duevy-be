import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeTransaction } from '../lib/serializers';
import { renderReceiptPdf } from '../lib/receipt';
import { pollInflow } from '../services/payment.service';

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

  // Actively check with Anchor rather than only reading our own possibly-stale
  // row, so the payer's screen can flip to success without waiting on the
  // webhook round-trip. The webhook remains the source of truth;
  // fulfilByReference is idempotent, so racing it is safe by construction.
  if (pending.status === 'pending') {
    try {
      const outcome = await pollInflow(reference);
      if (outcome !== 'pending') pending = await db.pendingPayment.findUnique({ where: { reference } });
    } catch (err) {
      console.error(`[payments] status check failed for ref=${reference}:`, err);
    }
  }

  const status = pending?.status === 'completed' ? 'completed' : pending?.status === 'failed' ? 'failed' : 'pending';
  const txn = await db.transaction.findUnique({ where: { reference } });

  // The checkout's virtual account, snapshotted onto the PendingPayment when it
  // was opened — lets the payment page re-render the transfer instructions and
  // its countdown from the reference alone, on reload or a fresh device.
  const meta = pending?.metadata as
    | {
        amount?: number;
        checkoutAccountNumber?: string;
        checkoutBankName?: string;
        checkoutAccountName?: string;
        checkoutExpiresAt?: string;
      }
    | undefined;

  const bankTransfer =
    status === 'pending' && meta?.checkoutAccountNumber
      ? {
          accountNumber: meta.checkoutAccountNumber,
          bankName: meta.checkoutBankName ?? '',
          accountName: meta.checkoutAccountName ?? '',
          amountKobo: meta.amount ?? 0,
          expiresAt: meta.checkoutExpiresAt ?? null,
        }
      : null;

  ok(res, {
    status,
    ...(meta?.amount !== undefined ? { amount: meta.amount } : {}),
    // Always present so clients can branch on it; Anchor has no hosted checkout.
    checkoutUrl: null,
    bankTransfer,
    ...(txn && status === 'completed' ? { transaction: serializeTransaction(txn) } : {}),
  });
});

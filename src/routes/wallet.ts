import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { ok, fail, errors } from '../lib/response';
import { serializeCard, serializeTransaction } from '../lib/serializers';
import {
  initOnlineTopUp,
  chargeCardForTopUp,
  initCardSave,
  CardNotFoundError,
  CardChargeFailedError,
} from '../services/payment.service';

export const walletRouter = Router();
walletRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// ---------------------------------------------------------------------------
// GET /wallet (§8.1)
// ---------------------------------------------------------------------------
walletRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const [user, pending] = await Promise.all([
    db.user.findUnique({ where: { id }, select: { walletBalance: true } }),
    db.transaction.aggregate({
      where: { userId: id, type: 'topup', status: 'pending' },
      _sum: { amount: true },
    }),
  ]);
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }
  ok(res, { balance: user.walletBalance, pendingBalance: pending._sum.amount ?? 0 });
});

// ---------------------------------------------------------------------------
// POST /wallet/top-up (§8.2) — Idempotency-Key required
// ---------------------------------------------------------------------------
const MIN_TOPUP = 10_000; // ₦100 in kobo
const MAX_TOPUP = 50_000_000; // ₦500,000 in kobo

const topUpSchema = z
  .object({
    amount: z.number().int().min(MIN_TOPUP).max(MAX_TOPUP),
    method: z.enum(['card', 'online']),
    cardId: z.string().optional(),
  })
  .refine((d) => d.method !== 'card' || !!d.cardId, { message: 'cardId is required for card top-ups', path: ['cardId'] });

walletRouter.post(
  '/top-up',
  requireIdempotencyKey,
  idempotent,
  validate(topUpSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { amount, method, cardId } = req.body as z.infer<typeof topUpSchema>;
    const user = await db.user.findUnique({ where: { id: uid(req) } });
    if (!user) {
      errors.notFound(res, 'User not found');
      return;
    }

    if (method === 'card') {
      try {
        const transaction = await chargeCardForTopUp(user, amount, cardId as string);
        ok(res, { transaction: serializeTransaction(transaction) });
      } catch (err) {
        if (err instanceof CardNotFoundError) {
          errors.notFound(res, 'Card not found');
          return;
        }
        if (err instanceof CardChargeFailedError) {
          fail(res, 402, 'CARD_DECLINED', 'Your card was declined');
          return;
        }
        throw err;
      }
      return;
    }

    const result = await initOnlineTopUp(user, amount);
    ok(res, result);
  },
);

// ---------------------------------------------------------------------------
// GET /wallet/cards (§8.3)
// ---------------------------------------------------------------------------
walletRouter.get('/cards', async (req: Request, res: Response): Promise<void> => {
  const cards = await db.card.findMany({
    where: { userId: uid(req) },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  ok(res, cards.map(serializeCard));
});

// ---------------------------------------------------------------------------
// POST /wallet/cards (§8.4) — redirect flow: a ₦50 verification charge on
// Monnify's hosted checkout tokenizes the card. The token is exchanged for a
// saved Card once the webhook/reconciliation fulfilment resolves the reference.
// ---------------------------------------------------------------------------
const addCardSchema = z.object({
  isDefault: z.boolean().default(false),
});

walletRouter.post(
  '/cards',
  requireIdempotencyKey,
  idempotent,
  validate(addCardSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { isDefault } = req.body as z.infer<typeof addCardSchema>;
    const user = await db.user.findUnique({ where: { id: uid(req) } });
    if (!user) {
      errors.notFound(res, 'User not found');
      return;
    }

    const result = await initCardSave(user, isDefault);
    ok(res, result);
  },
);

// ---------------------------------------------------------------------------
// PATCH /wallet/cards/{cardId} (§8.5) — promote to default
// ---------------------------------------------------------------------------
const patchCardSchema = z.object({ isDefault: z.literal(true) });

walletRouter.patch('/cards/:cardId', validate(patchCardSchema), async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const cardId = req.params.cardId as string;

  const card = await db.card.findFirst({ where: { id: cardId, userId: id } });
  if (!card) {
    errors.notFound(res, 'Card not found');
    return;
  }

  const updated = await db.$transaction(async (tx) => {
    await tx.card.updateMany({ where: { userId: id, isDefault: true }, data: { isDefault: false } });
    return tx.card.update({ where: { id: cardId }, data: { isDefault: true } });
  });

  ok(res, serializeCard(updated));
});

// ---------------------------------------------------------------------------
// DELETE /wallet/cards/{cardId} (§8.6) — deleting the default promotes the next
// ---------------------------------------------------------------------------
walletRouter.delete('/cards/:cardId', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const cardId = req.params.cardId as string;

  const card = await db.card.findFirst({ where: { id: cardId, userId: id } });
  if (!card) {
    errors.notFound(res, 'Card not found');
    return;
  }

  await db.$transaction(async (tx) => {
    await tx.card.delete({ where: { id: cardId } });
    if (card.isDefault) {
      const next = await tx.card.findFirst({ where: { userId: id }, orderBy: { createdAt: 'desc' } });
      if (next) await tx.card.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /wallet/activity (§8.7) — compact projection of wallet-touching rows
// ---------------------------------------------------------------------------
walletRouter.get('/activity', async (req: Request, res: Response): Promise<void> => {
  const rows = await db.transaction.findMany({
    where: {
      userId: uid(req),
      OR: [{ method: 'Wallet' }, { type: { in: ['topup', 'withdrawal', 'refund', 'referral'] } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  ok(
    res,
    rows.map((t) => ({
      id: t.id,
      label: t.title,
      detail: t.detail,
      amount: t.amount,
      createdAt: t.createdAt.toISOString(),
    })),
  );
});

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { ok, errors } from '../lib/response';
import { serializeCard } from '../lib/serializers';
import { initCardSave } from '../services/payment.service';
import { getGatewayLabel } from '../lib/paymentGateway';

// Saved cards + the active-gateway label. The wallet balance/top-up system
// was removed in the payment architecture migration (float custody risk) —
// every payment now goes through a saved card or the in-app bank-transfer
// invoice flow (see POST /dues/:dueId/pay, POST /payments), never a stored
// balance. This router kept its historical mount path (/wallet) so existing
// card-management clients don't need to change; only the balance/top-up
// endpoints that used to live here are gone.
export const walletRouter = Router();
walletRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// ---------------------------------------------------------------------------
// GET /wallet/payment-gateway — which processor is currently live, for
// dashboard copy like "Pay with Paystack" / "You'll be redirected to Monnify".
// Read-only label only — no credential/config details (that's admin-only,
// see GET /admin/settings/payment-gateway).
// ---------------------------------------------------------------------------
walletRouter.get('/payment-gateway', async (_req: Request, res: Response): Promise<void> => {
  ok(res, { active: await getGatewayLabel() });
});

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
// the active gateway's hosted checkout tokenizes the card. Deliberately kept
// on the redirect (a bank-transfer invoice can't mint a reusable card token)
// — see initCardSave's own comment. The token is exchanged for a saved Card
// once the webhook/reconciliation fulfilment resolves the reference.
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

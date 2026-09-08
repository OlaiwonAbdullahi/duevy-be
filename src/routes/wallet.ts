import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok } from '../lib/response';

// The wallet balance/top-up system was removed in the payment architecture
// migration (float custody risk), and card payments are not part of
// Anchor's BaaS product — every payment is now a bank transfer to a single-use
// Anchor virtual account (see POST /dues/:dueId/pay, POST /polls/:slug/votes). This router kept its historical mount path
// (/wallet) so existing clients reading GET /wallet/payment-gateway don't
// need to change; card management is gone.
export const walletRouter = Router();
walletRouter.use(authenticate);

// ---------------------------------------------------------------------------
// GET /wallet/payment-gateway — kept for frontend backward-compatibility
// (dashboard copy like "Pay with X"). Fixed now that Anchor is the sole,
// non-switchable provider.
// ---------------------------------------------------------------------------
walletRouter.get('/payment-gateway', async (_req: Request, res: Response): Promise<void> => {
  ok(res, { active: 'Anchor' });
});

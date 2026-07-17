import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok, fail } from '../lib/response';
import { getBanks } from '../lib/paymentGateway';

export const banksRouter = Router();
banksRouter.use(authenticate);

// ---------------------------------------------------------------------------
// GET /banks — Nigerian banks the active payment gateway supports for payouts (§10.2)
// ---------------------------------------------------------------------------
banksRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const banks = await getBanks();
    ok(res, banks);
  } catch (err) {
    console.error('[banks] failed to fetch bank list:', err);
    fail(res, 502, 'PROVIDER_ERROR', 'Could not fetch the bank list right now');
  }
});

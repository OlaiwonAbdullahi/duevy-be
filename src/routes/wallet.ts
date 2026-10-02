import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok } from '../lib/response';
import { getPaymentProvider } from '../providers/payment';

// There is no student wallet: every payment is a bank transfer into a one-time
// account opened per checkout (POST /dues/pay). This router keeps its
// historical mount path so clients reading GET /wallet/payment-gateway work.
export const walletRouter = Router();
walletRouter.use(authenticate);

// GET /wallet/payment-gateway — which rail is live, for dashboard copy.
walletRouter.get('/payment-gateway', async (_req: Request, res: Response): Promise<void> => {
  const name = getPaymentProvider().name;
  ok(res, { active: name === 'bachs' ? 'Bachs' : name, method: 'bank_transfer' });
});

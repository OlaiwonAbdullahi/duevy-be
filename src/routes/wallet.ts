import { Router, type Request, type Response } from 'express';
import { db } from '../config/db';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, fail, errors } from '../lib/response';
import { logger } from '../lib/logger';
import { getPaymentProvider } from '../providers/payment';

// Students have no wallet: every payment is a bank transfer into a one-time
// account opened per checkout (POST /dues/pay). Reps do: a Bank78 sub-account
// that their spaces' collections are routed into and withdrawals come out of.
export const walletRouter = Router();
walletRouter.use(authenticate);

// GET /wallet/payment-gateway — which rail is live, for dashboard copy.
walletRouter.get('/payment-gateway', async (_req: Request, res: Response): Promise<void> => {
  const name = getPaymentProvider().name;
  ok(res, { active: name === 'bank78' ? 'Bank78' : name, method: 'bank_transfer' });
});

// GET /wallet/me — the caller's rep wallet and its live Bank78 balance.
walletRouter.get('/me', async (req: Request, res: Response): Promise<void> => {
  const user = await db.user.findUnique({
    where: { id: (req as AuthenticatedRequest).user.sub as string },
    select: { walletAccountNumber: true },
  });
  if (!user?.walletAccountNumber) {
    errors.notFound(res, 'You have no wallet yet. It opens once your identity is verified.');
    return;
  }
  try {
    const wallet = await getPaymentProvider().getWallet(user.walletAccountNumber);
    ok(res, { accountNumber: wallet.accountNumber, bankName: wallet.bankName, active: wallet.active, availableKobo: wallet.availableKobo });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'wallet balance lookup failed');
    fail(res, 502, 'PROVIDER_ERROR', 'Could not fetch your wallet right now');
  }
});

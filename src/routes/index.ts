import { Router, type Request, type Response } from 'express';
import { authRouter } from './auth';
import { meRouter } from './me';
import { spacesRouter } from './spaces';
import { walletRouter } from './wallet';
import { duesRouter } from './dues';
import { transactionsRouter, paymentsRouter } from './transactions';
import { webhooksRouter } from './webhooks';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/spaces', spacesRouter);
apiRouter.use('/wallet', walletRouter);
apiRouter.use('/dues', duesRouter);
apiRouter.use('/transactions', transactionsRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/webhooks', webhooksRouter);

// Stubs for future phases
const stubHandler = (_req: Request, res: Response) =>
  res
    .status(501)
    .json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } });

for (const path of ['/payouts', '/polls', '/referrals', '/notifications', '/admin', '/disputes']) {
  apiRouter.use(path, stubHandler);
}

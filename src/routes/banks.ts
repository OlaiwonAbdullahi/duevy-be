import { Router, type Request, type Response } from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, fail, errors } from '../lib/response';
import { db } from '../config/db';
import { getBanksForAccount } from '../lib/bachs';
import { ensureConnectedAccount } from '../services/connectAccount.service';

export const banksRouter = Router();
banksRouter.use(authenticate);

// ---------------------------------------------------------------------------
// GET /banks?spaceId=... — Nigerian banks Bachs supports for that space's
// payout destination (§10.2). Bank lists are scoped per Bachs connected
// account (unlike Paystack/Monnify's gateway-wide list), so a spaceId is
// now required — creates the space's connected account on first use if none
// exists yet (harmless, no financial commitment).
// ---------------------------------------------------------------------------
banksRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const spaceId = req.query.spaceId as string | undefined;
  if (!spaceId) {
    errors.validation(res, [{ field: 'spaceId', issue: 'spaceId query parameter is required' }]);
    return;
  }

  const userId = (req as AuthenticatedRequest).user.sub as string;
  const rep = await db.spaceRep.findUnique({ where: { userId_spaceId: { userId, spaceId } } });
  if (!rep) {
    errors.forbidden(res, 'Only a rep of this space can view its bank list');
    return;
  }

  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    const accountId = await ensureConnectedAccount(spaceId, user?.email ?? '');
    const banks = await getBanksForAccount(accountId);
    ok(res, banks);
  } catch (err) {
    console.error('[banks] failed to fetch bank list:', err);
    fail(res, 502, 'PROVIDER_ERROR', 'Could not fetch the bank list right now');
  }
});

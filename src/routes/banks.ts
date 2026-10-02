import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok, fail } from '../lib/response';
import { logger } from '../lib/logger';
import { getPaymentProvider, type Bank } from '../providers/payment';

export const banksRouter = Router();
banksRouter.use(authenticate);

// The list changes rarely and every rep setting a payout account fetches it.
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { banks: Bank[]; at: number } | null = null;

/** The provider's Nigerian bank list, cached for an hour; a stale list beats none. */
export async function listBanksCached(): Promise<Bank[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.banks;
  try {
    const banks = await getPaymentProvider().listBanks();
    cache = { banks, at: Date.now() };
    return banks;
  } catch (err) {
    if (cache) {
      logger.warn({ err: (err as Error).message }, 'bank list refresh failed — serving stale list');
      return cache.banks;
    }
    throw err;
  }
}

// GET /banks — Nigerian banks available as a payout destination (§10.2).
banksRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    ok(res, await listBanksCached());
  } catch {
    fail(res, 502, 'PROVIDER_ERROR', 'Could not fetch the bank list right now');
  }
});

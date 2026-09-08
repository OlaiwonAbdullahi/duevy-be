import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok, fail } from '../lib/response';
import { getBanks, type Bank } from '../lib/anchor';

export const banksRouter = Router();
banksRouter.use(authenticate);

// The list changes rarely and every rep setting a payout account fetches it.
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { banks: Bank[]; at: number } | null = null;

// ---------------------------------------------------------------------------
// GET /banks — Nigerian banks available as a payout destination (§10.2).
//
// Anchor's bank list is organisation-level, so unlike the Bachs version this
// takes no spaceId and needs no account to exist first. The parameter is still
// accepted and ignored, so existing clients keep working.
// ---------------------------------------------------------------------------
banksRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    ok(res, cache.banks);
    return;
  }

  try {
    const banks = await getBanks();
    cache = { banks, at: Date.now() };
    ok(res, banks);
  } catch (err) {
    console.error('[banks] failed to fetch bank list:', err);
    // Serve a stale list rather than blocking a payout setup on a provider blip.
    if (cache) {
      ok(res, cache.banks);
      return;
    }
    fail(res, 502, 'PROVIDER_ERROR', 'Could not fetch the bank list right now');
  }
});

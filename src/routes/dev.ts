import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { ok, fail, errors } from '../lib/response';
import { logger } from '../lib/logger';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { reconcileCheckout } from '../jobs/reconciliation';

/**
 * Sandbox-only helpers for wiring and testing the frontend. Never live:
 *
 *  - 9jaPay: only on the sandbox base URL, and only with
 *    NINEJAPAY_SANDBOX_AUTH_KEY set (simulate-deposit needs it).
 *  - The fake provider: only outside production.
 *
 * Anywhere else every route here answers 404, as if it didn't exist.
 */
export const devRouter = Router();

const SANDBOX_HOST = 'developer.test.9japay.com';

export function devToolsEnabled(): boolean {
  if (!getPaymentProvider().simulateDeposit) return false;
  if (env.PAYMENT_PROVIDER === 'fake') return env.NODE_ENV !== 'production';
  return new URL(env.NINEJAPAY_BASE_URL).host === SANDBOX_HOST && !!env.NINEJAPAY_SANDBOX_AUTH_KEY;
}

devRouter.use((_req, res, next) => {
  if (!devToolsEnabled()) {
    errors.notFound(res);
    return;
  }
  next();
});

const simulateSchema = z.object({
  accountNumber: z.string().trim().regex(/^\d{10}$/, 'must be 10 digits'),
  /** Kobo, like every amount in this API. A checkout's one-time account takes only its exact total. */
  amount: z.number().int().positive(),
});

/** 9jaPay's transaction list can lag the deposit by a moment, so the checkout is checked a few times. */
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_GAP_MS = 1_500;

// ---------------------------------------------------------------------------
// POST /dev/simulate-deposit — pretend a student transferred `amount` kobo
// into `accountNumber`, then confirm the checkout holding it straight away
// (9jaPay's webhook can't reach localhost; the pay page turns "paid" on its
// next status poll either way).
// ---------------------------------------------------------------------------
devRouter.post('/simulate-deposit', validate(simulateSchema), async (req: Request, res: Response): Promise<void> => {
  const { accountNumber, amount } = req.body as z.infer<typeof simulateSchema>;
  const checkout = await db.checkout.findFirst({
    where: { vaAccountNumber: accountNumber, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  if (checkout && checkout.totalKobo !== amount) {
    // 9jaPay would refuse it with a confusing "Recipient account is invalid".
    fail(res, 422, 'AMOUNT_MISMATCH', `This account only accepts exactly ${checkout.totalKobo} kobo (checkout ${checkout.reference}).`, [
      { field: 'amount', issue: `expected ${checkout.totalKobo}` },
    ]);
    return;
  }

  try {
    await getPaymentProvider().simulateDeposit!(accountNumber, amount);
  } catch (err) {
    // A sandbox tool: say what 9jaPay said. "25" means an unknown, closed or
    // already-paid account, or the wrong amount; a closed one can also come back as a 500.
    if (err instanceof ProviderError) {
      fail(res, 422, 'DEPOSIT_REFUSED', `9jaPay refused the deposit: ${err.message}`);
      return;
    }
    throw err;
  }
  logger.info({ accountNumber, amount, ref: checkout?.reference }, 'sandbox deposit simulated');

  let status = checkout?.status ?? null;
  if (checkout) {
    for (let i = 0; i < CONFIRM_ATTEMPTS && status === 'pending'; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, CONFIRM_GAP_MS));
      await reconcileCheckout(checkout, { expireIfPastDue: false, source: 'sandbox deposit' }).catch((err) =>
        logger.warn({ ref: checkout.reference, err: (err as Error).message }, 'sandbox deposit: confirmation deferred'),
      );
      status = (await db.checkout.findUniqueOrThrow({ where: { id: checkout.id }, select: { status: true } })).status;
    }
  }

  ok(res, {
    accountNumber,
    amount,
    // The checkout this account belongs to, if any; still `pending` means the
    // reconciliation job (or the pay page's next poll) will pick it up shortly.
    checkout: checkout ? { reference: checkout.reference, status } : null,
  });
});

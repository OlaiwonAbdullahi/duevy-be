import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { ok, fail, errors } from '../lib/response';
import { logger } from '../lib/logger';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { reconcileCheckout } from '../jobs/reconciliation';
import { fulfilCheckout } from '../services/checkout.service';

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
  if (env.NODE_ENV === 'production') return false;
  // Interswitch: the gateway popup can't be driven from the server, so we offer
  // a simulate-payment shortcut instead of simulate-deposit — test env only.
  if (env.PAYMENT_PROVIDER === 'interswitch') return env.INTERSWITCH_ENV === 'test';
  if (!getPaymentProvider().simulateDeposit) return false;
  if (env.PAYMENT_PROVIDER === 'fake') return true;
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
  if (!getPaymentProvider().simulateDeposit) {
    // Gateway rails (Interswitch) have no bank account to deposit into — use /dev/simulate-payment.
    fail(res, 400, 'NOT_SUPPORTED', 'This provider collects via a payment gateway; use POST /dev/simulate-payment with { reference }.');
    return;
  }
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

// ---------------------------------------------------------------------------
// POST /dev/simulate-payment — mark a pending gateway checkout (Interswitch)
// paid, without going through the real popup. Test environment only
// (devToolsEnabled). Fulfils it through the same idempotent path a real
// gettransaction.json "00" would, regardless of which method the student would
// have used (card, transfer, USSD, QR).
// ---------------------------------------------------------------------------
const simulatePaymentSchema = z.object({
  reference: z.string().trim().min(3).max(64),
});

devRouter.post('/simulate-payment', validate(simulatePaymentSchema), async (req: Request, res: Response): Promise<void> => {
  if (!getPaymentProvider().collectsByGateway) {
    fail(res, 400, 'NOT_SUPPORTED', 'This provider does not use a payment gateway; use POST /dev/simulate-deposit.');
    return;
  }
  const { reference } = req.body as z.infer<typeof simulatePaymentSchema>;
  const checkout = await db.checkout.findFirst({ where: { reference, status: 'pending' } });
  if (!checkout) {
    fail(res, 404, 'NOT_FOUND', `No pending checkout with reference ${reference}.`);
    return;
  }
  await fulfilCheckout(checkout.id, checkout.totalKobo, 0, 'sandbox payment', null, `DEVSIM-${checkout.reference}`);
  const status = (await db.checkout.findUniqueOrThrow({ where: { id: checkout.id }, select: { status: true } })).status;
  logger.info({ reference, status }, 'sandbox gateway payment simulated');
  ok(res, { reference, status });
});

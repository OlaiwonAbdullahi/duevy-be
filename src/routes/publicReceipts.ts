import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import {
  receiptAccessLimiter,
  receiptLookupLimiter,
  receiptLookupNetworkLimiter,
  receiptVerifyLimiter,
} from '../middleware/rateLimiter';
import { ok, errors } from '../lib/response';
import { logger } from '../lib/logger';
import { sendReceiptLookupEmail } from '../lib/email';
import { createReceiptAccessToken, readReceiptAccessToken } from '../lib/receiptAccess';
import {
  listReceiptsForEmail,
  renderReceiptForEmail,
  verifyReceipt,
} from '../services/receipt.service';

/**
 * Public receipt pages — no account needed.
 *
 * - GET  /public/receipts/verify/{number}  what a scanned QR code checks:
 *        is this a real, paid Duevy receipt, and what does it say.
 * - POST /public/receipts/lookup {email}  email a short-lived link to every
 *        receipt issued to that address. Always answers the same way, so it
 *        can't be used to learn who has paid.
 * - GET  /public/receipts?t=              the receipts the link unlocks.
 * - GET  /public/receipts/{number}/pdf?t= one of them, as the PDF.
 *
 * Mounted at /public, unauthenticated.
 */
export const publicReceiptsRouter = Router();

publicReceiptsRouter.get('/receipts/verify/:number', receiptVerifyLimiter, async (req: Request, res: Response): Promise<void> => {
  const result = await verifyReceipt(String(req.params.number ?? ''));
  if (!result) {
    errors.notFound(res, 'No Duevy receipt has this number');
    return;
  }
  ok(res, result);
});

const lookupSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
});

publicReceiptsRouter.post(
  '/receipts/lookup',
  receiptLookupNetworkLimiter,
  validate(lookupSchema),
  receiptLookupLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as z.infer<typeof lookupSchema>;
    // Answer before (and regardless of) the lookup, so timing and the
    // response can't tell anyone whether this email has paid for anything.
    ok(res, { sent: true });
    try {
      const receipts = await listReceiptsForEmail(email);
      if (receipts.length === 0) return;
      const link = `${env.FRONTEND_URL}/receipts?t=${encodeURIComponent(createReceiptAccessToken(email))}`;
      await sendReceiptLookupEmail(email, link, receipts.length);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'receipt lookup email failed');
    }
  },
);

function emailFromToken(req: Request, res: Response): string | null {
  const email = readReceiptAccessToken(typeof req.query.t === 'string' ? req.query.t : '');
  if (!email) {
    errors.unauthorized(res, 'This link has expired. Ask for a new one.');
    return null;
  }
  return email;
}

publicReceiptsRouter.get('/receipts', receiptAccessLimiter, async (req: Request, res: Response): Promise<void> => {
  const email = emailFromToken(req, res);
  if (!email) return;
  ok(res, { email, receipts: await listReceiptsForEmail(email) });
});

publicReceiptsRouter.get('/receipts/:number/pdf', receiptAccessLimiter, async (req: Request, res: Response): Promise<void> => {
  const email = emailFromToken(req, res);
  if (!email) return;
  const { filename, pdf } = await renderReceiptForEmail(String(req.params.number ?? ''), email);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.status(200).send(pdf);
});

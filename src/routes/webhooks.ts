import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { fulfilByReference } from '../services/payment.service';

export const webhooksRouter = Router();

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', env.MONNIFY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// POST /webhooks/monnify (§15.1) — Public, signature-verified.
// Single ingestion point for hosted-checkout completions.
// ---------------------------------------------------------------------------
webhooksRouter.post('/monnify', async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const signature = req.headers['monnify-signature'] as string | undefined;

  if (!verifySignature(rawBody, signature)) {
    res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
    return;
  }

  const body = req.body as {
    eventType?: string;
    eventData?: { paymentReference?: string; transactionReference?: string; paymentStatus?: string };
  };
  const data = body.eventData ?? {};
  const reference = data.paymentReference;

  // Acknowledge malformed/irrelevant events quickly so Monnify stops retrying.
  if (!reference) {
    res.status(200).json({ success: true });
    return;
  }

  const success = body.eventType === 'SUCCESSFUL_TRANSACTION' || data.paymentStatus === 'PAID';

  // Fulfilment is idempotent on the reference (guards Monnify retries).
  try {
    await fulfilByReference(reference, success);
  } catch (err) {
    console.error('[webhook] fulfilment error:', err);
    // Still 200 so Monnify doesn't hammer retries; reconciliation will catch it.
  }

  res.status(200).json({ success: true });
});

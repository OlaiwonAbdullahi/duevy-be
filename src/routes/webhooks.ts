import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { fulfilByReference } from '../services/payment.service';
import { settlePayout } from '../services/payout.service';

export const webhooksRouter = Router();

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !env.MONNIFY_WEBHOOK_SECRET) return false;
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
    eventData?: {
      paymentReference?: string;
      transactionReference?: string;
      // Present on transactions that originated from Create Invoice — this is
      // the invoiceReference we specified (== our PendingPayment.reference),
      // distinct from paymentReference/transactionReference, which are
      // Monnify's own auto-generated IDs for the underlying transaction.
      invoiceReference?: string;
      paymentStatus?: string;
      reference?: string;
      status?: string;
    };
  };
  const data = body.eventData ?? {};

  console.log(`[webhook] monnify eventType=${body.eventType ?? 'unknown'}:`, JSON.stringify(body));

  // Disbursement events (payouts) carry `reference` + `status` rather than
  // `paymentReference` + `paymentStatus`; they resolve a Payout, not a PendingPayment.
  if (body.eventType === 'SUCCESSFUL_DISBURSEMENT' || body.eventType === 'FAILED_DISBURSEMENT') {
    const payoutRef = data.reference ?? data.transactionReference;
    if (payoutRef) {
      try {
        await settlePayout(
          payoutRef,
          body.eventType === 'SUCCESSFUL_DISBURSEMENT',
          body.eventType === 'FAILED_DISBURSEMENT' ? 'The payment provider reported the transfer failed' : undefined,
        );
      } catch (err) {
        console.error('[webhook] payout settlement error:', err);
      }
    }
    res.status(200).json({ success: true });
    return;
  }

  // invoiceReference matches our PendingPayment.reference for Create Invoice
  // payments; paymentReference is the equivalent for a plain init-transaction
  // charge. Try both — whichever this event actually is, one of them matches.
  const reference = data.invoiceReference ?? data.paymentReference;

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

// ---------------------------------------------------------------------------
// POST /webhooks/paystack (§15.1) — Public, signature-verified.
// Mirrors the Monnify handler above for whichever events Paystack sends;
// the fulfilment functions themselves are gateway-agnostic already.
// ---------------------------------------------------------------------------
function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !env.PAYSTACK_SECRET_KEY) return false;
  const expected = createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

webhooksRouter.post('/paystack', async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const signature = req.headers['x-paystack-signature'] as string | undefined;

  if (!verifyPaystackSignature(rawBody, signature)) {
    res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
    return;
  }

  const body = req.body as {
    event?: string;
    data?: { reference?: string; status?: string };
  };
  const data = body.data ?? {};

  console.log(`[webhook] paystack event=${body.event ?? 'unknown'}:`, JSON.stringify(body));

  if (body.event === 'transfer.success' || body.event === 'transfer.failed' || body.event === 'transfer.reversed') {
    if (data.reference) {
      try {
        await settlePayout(
          data.reference,
          body.event === 'transfer.success',
          body.event !== 'transfer.success' ? 'The payment provider reported the transfer failed' : undefined,
        );
      } catch (err) {
        console.error('[webhook] payout settlement error:', err);
      }
    }
    res.status(200).json({ success: true });
    return;
  }

  // Paystack only webhooks successful charges — failures are surfaced via the
  // client's own verify call / redirect, not a dedicated failure event — so
  // only `charge.success` drives fulfilment here; anything else is acked and ignored.
  if (body.event === 'charge.success' && data.reference) {
    try {
      await fulfilByReference(data.reference, data.status === 'success');
    } catch (err) {
      console.error('[webhook] fulfilment error:', err);
    }
  }

  res.status(200).json({ success: true });
});

import { Router, type Request, type Response } from 'express';
import { getPaymentProvider, InvalidSignatureError, MalformedEventError } from '../providers/payment';
import { enqueueEvent, recordMalformedEvent } from '../services/webhookProcessor.service';
import { kickWebhookWorker } from '../jobs/webhookWorker';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { verifyWebhookChallenge, verifyWebhookSignature, processCloudWebhook, recordWebhookSignature, getWebhookDiag } from '../channels/whatsapp/cloud';

export const webhooksRouter = Router();

/**
 * POST /webhooks/interswitch — public; authenticated by signature only.
 * Register this URL in the provider's dashboard (test and live).
 *
 * Does the minimum and returns 200 fast:
 *   1. Verify the signature over the exact raw bytes (401 if it fails).
 *   2. Enqueue, deduplicated by the event id (a duplicate is a no-op).
 *   3. 200. The work happens in src/jobs/webhookWorker.ts.
 *
 * A 5xx is returned only if we could not durably store the event, so the
 * provider resends it. Anything authenticated but unreadable is stored as
 * `dead` for a human and acknowledged — retrying it would never succeed.
 */
async function handleProviderWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const provider = getPaymentProvider();

  let event;
  try {
    event = provider.parseWebhook(rawBody, req.headers);
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      logger.warn({ reason: err.message, ip: req.ip }, 'webhook rejected');
      res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
      return;
    }
    if (err instanceof MalformedEventError) {
      logger.error({ eventId: err.eventId, type: err.eventType, reason: err.message }, 'authenticated webhook could not be parsed');
      if (err.eventId) {
        await recordMalformedEvent(provider.name, err.eventId, err.eventType ?? 'unknown', req.body, err.message);
      }
      res.status(200).json({ success: true });
      return;
    }
    throw err;
  }

  try {
    const result = await enqueueEvent(provider.name, event, req.body);
    logger.info({ eventId: event.eventId, type: event.rawType, kind: event.kind, result }, 'webhook received');
  } catch (err) {
    logger.error({ eventId: event.eventId, err: (err as Error).message }, 'webhook could not be stored');
    res.status(503).json({ success: false, error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Retry later' } });
    return;
  }

  res.status(200).json({ success: true });
  if (env.RUN_WORKERS && env.NODE_ENV !== 'test') kickWebhookWorker();
}

/**
 * Provider webhook. Verifies and normalises the event through whichever
 * provider is configured (PAYMENT_PROVIDER). Register this URL in the
 * provider's dashboard.
 *
 *   POST /webhooks/interswitch  — Interswitch (Quickteller Business → webhooks)
 */
webhooksRouter.post('/interswitch', handleProviderWebhook);

/**
 * POST /webhooks/bachs — retired. Acknowledged and dropped so Bachs stops
 * retrying while the old endpoint is switched off; nothing is processed.
 */
webhooksRouter.post('/bachs', (_req: Request, res: Response): void => {
  res.status(200).json({ success: true });
});

/**
 * WhatsApp Cloud API webhook (WHATSAPP_PROVIDER=cloud). Register this URL plus
 * your verify token in the Meta app (WhatsApp → Configuration → Webhook), and
 * subscribe to the `messages` field.
 *
 *   GET  /webhooks/whatsapp — Meta's subscription handshake (echo the challenge).
 *   POST /webhooks/whatsapp — inbound messages; signature-verified, then 200 fast.
 */
webhooksRouter.get('/whatsapp', (req: Request, res: Response): void => {
  const challenge = verifyWebhookChallenge(req.query as Record<string, unknown>);
  if (challenge) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.sendStatus(403);
});

webhooksRouter.post('/whatsapp', (req: Request, res: Response): void => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const signatureOk = verifyWebhookSignature(rawBody, req.header('x-hub-signature-256'));
  // Record every delivery (pass or fail) for /whatsapp/diag.
  recordWebhookSignature(signatureOk);
  logger.info({ signatureOk, hasSig: !!req.header('x-hub-signature-256') }, 'whatsapp webhook POST received');
  if (!signatureOk) {
    logger.warn({ ip: req.ip }, 'whatsapp webhook rejected (bad signature)');
    res.sendStatus(401);
    return;
  }
  // Ack immediately — Meta retries on any non-200 and times out quickly. The
  // actual work (transcribe/agent/reply) happens after we've responded.
  res.sendStatus(200);
  void processCloudWebhook(req.body);
});

/**
 * GET /webhooks/whatsapp/diag?key=<WHATSAPP_VERIFY_TOKEN> — a redacted snapshot
 * of the LAST webhook interaction (no numbers/text), to debug delivery without
 * server logs. Gated by the verify token so it isn't publicly readable.
 */
webhooksRouter.get('/whatsapp/diag', (req: Request, res: Response): void => {
  if (!env.WHATSAPP_VERIFY_TOKEN || req.query.key !== env.WHATSAPP_VERIFY_TOKEN) {
    res.sendStatus(403);
    return;
  }
  res.status(200).json({
    success: true,
    data: {
      provider: env.WHATSAPP_PROVIDER,
      sttEnabled: env.STT_ENABLED,
      hasPhoneNumberId: !!env.WHATSAPP_PHONE_NUMBER_ID,
      hasAccessToken: !!env.WHATSAPP_ACCESS_TOKEN,
      hasAppSecret: !!env.WHATSAPP_APP_SECRET,
      lastWebhook: getWebhookDiag() ?? 'no webhook POST received yet',
    },
  });
});

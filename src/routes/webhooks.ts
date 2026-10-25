import { Router, type Request, type Response } from 'express';
import { getPaymentProvider, InvalidSignatureError, MalformedEventError } from '../providers/payment';
import { enqueueEvent, recordMalformedEvent } from '../services/webhookProcessor.service';
import { kickWebhookWorker } from '../jobs/webhookWorker';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export const webhooksRouter = Router();

/**
 * POST /webhooks/kredi — public; authenticated by signature only. Kredi posts
 * collection webhooks here (the URL is set on each payment link) and payout
 * webhooks (the URL is set on the Kredi dashboard).
 *
 * Does the minimum and returns 200 fast:
 *   1. Verify the signature-key over the raw body (401 if it fails).
 *   2. Enqueue, deduplicated by an id built from Kredi's own references (a
 *      duplicate is a no-op).
 *   3. 200. The work happens in src/jobs/webhookWorker.ts.
 *
 * A 5xx is returned only if we could not durably store the event, so Kredi
 * retries it. Anything authenticated but unreadable is stored as `dead` for a
 * human and acknowledged — retrying it would never succeed.
 */
webhooksRouter.post('/kredi', async (req: Request, res: Response): Promise<void> => {
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
});

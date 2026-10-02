import { type Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { db } from '../config/db';
import { logger, scrub } from '../lib/logger';
import { type ProviderEvent } from '../providers/payment';
import { expireCheckout, findCheckoutId, fulfilCheckout, markUnderpaid } from './checkout.service';
import { completePayout, failPayoutByReference } from './withdrawal.service';
import { refreshIdentity } from './kyc.service';

/**
 * Inbound webhook pipeline.
 *
 *   route  → verify signature → enqueue (dedupe on provider event id) → 200
 *   worker → claim → processEvent → processed | retry with backoff | dead
 *
 * Duplicates are stopped twice: the unique (provider, providerEventId) key at
 * enqueue, and idempotent handlers (state machine + row locks + ledger unique
 * keys) for the same OUTCOME arriving under different event ids, e.g. a
 * webhook racing the reconciliation poll.
 */

export interface StoredEventPayload {
  event: ProviderEvent;
  /** The provider's body, scrubbed of sensitive fields. */
  raw: unknown;
}

export type EnqueueResult = 'queued' | 'duplicate';

export async function enqueueEvent(provider: string, event: ProviderEvent, rawBody: unknown): Promise<EnqueueResult> {
  const payload: StoredEventPayload = { event, raw: scrub(rawBody) };
  const inserted = await db.$executeRaw`
    INSERT INTO "webhook_events" ("id", "provider", "providerEventId", "type", "payload", "status", "attempts", "nextAttemptAt", "receivedAt")
    VALUES (${`whe_${ulid()}`}, ${provider}, ${event.eventId}, ${event.rawType},
            ${JSON.stringify(payload)}::jsonb, ${event.kind === 'ignored' ? 'processed' : 'received'}::"WebhookStatus", 0, (${new Date()}::timestamptz AT TIME ZONE 'UTC'), (${new Date()}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT ("provider", "providerEventId") DO NOTHING`;
  return inserted === 1 ? 'queued' : 'duplicate';
}

/** Store an event we could authenticate but not understand, for a human. */
export async function recordMalformedEvent(provider: string, eventId: string, type: string, rawBody: unknown, error: string): Promise<void> {
  await db.webhookEvent
    .create({
      data: {
        provider,
        providerEventId: eventId,
        type,
        payload: { raw: scrub(rawBody) } as Prisma.InputJsonValue,
        status: 'dead',
        error,
      },
    })
    .catch(() => {}); // a duplicate of a malformed event is still malformed
}

function rehydrate(event: ProviderEvent): ProviderEvent {
  return { ...event, occurredAt: new Date(event.occurredAt) };
}

export async function processEvent(stored: ProviderEvent): Promise<void> {
  const event = rehydrate(stored);
  const log = { eventId: event.eventId, type: event.rawType, kind: event.kind };

  switch (event.kind) {
    case 'payment.succeeded': {
      const id = await findCheckoutId(event.reference, event.providerCheckoutId);
      const outcome = await fulfilCheckout(id, event.receivedKobo, event.overpaidKobo, `webhook ${event.eventId}`);
      logger.info({ ...log, ref: event.reference, outcome }, 'payment event applied');
      return;
    }
    case 'payment.underpaid': {
      const id = await findCheckoutId(event.reference, event.providerCheckoutId);
      await markUnderpaid(id, event.receivedKobo, event.expectedKobo, `webhook ${event.eventId}`);
      return;
    }
    case 'payment.expired': {
      const id = await findCheckoutId(event.reference, event.providerCheckoutId);
      await expireCheckout(id);
      return;
    }
    case 'payment.failed': {
      // On a bank transfer a failed charge means the one-time account is dead;
      // the student needs a new checkout. Closed as expired (the spec's states).
      const id = await findCheckoutId(event.reference, event.providerCheckoutId);
      await expireCheckout(id, `provider failed: ${event.reason ?? 'unknown reason'}`);
      return;
    }
    case 'payout.succeeded': {
      if (!event.reference) throw new Error('payout event without a reference');
      const applied = await completePayout(event.reference, event.providerFeeKobo);
      if (!applied) logger.info({ ...log, ref: event.reference }, 'payout success already applied or unknown');
      return;
    }
    case 'payout.failed': {
      if (!event.reference) throw new Error('payout event without a reference');
      await failPayoutByReference(event.reference, event.reason ?? 'The bank could not complete the transfer');
      return;
    }
    case 'identity.updated':
      await refreshIdentity(event.accountId);
      return;
    case 'ignored':
      return;
  }
}

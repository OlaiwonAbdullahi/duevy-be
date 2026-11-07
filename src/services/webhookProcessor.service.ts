import { type Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { db } from '../config/db';
import { syncDirectDepositsForAccount } from './directDeposit.service';
import { logger, scrub } from '../lib/logger';
import { type ProviderEvent } from '../providers/payment';
import { CheckoutNotFoundError, findCheckoutId } from './checkout.service';
import { refreshPayout } from './withdrawal.service';
import { refreshSweep, refreshSweepsForAccount } from './sweep.service';
import { confirmReceivedPayment } from '../jobs/reconciliation';

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
 *
 * 9jaPay events carry no timestamp, so a captured one could be replayed. No
 * handler acts on an event's contents: each asks 9jaPay (the account's
 * transactions, the transfer status query) and applies that answer.
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
    case 'payment.received': {
      // Ask the provider what actually arrived; only its answer moves the checkout.
      // A reused account number may still carry the reference of the checkout
      // it was first opened for, so the open checkouts now holding that number
      // are checked too. Each one only takes a credit inside its own window
      // that no other checkout has claimed.
      const byRef = await findCheckoutId(null, event.providerCheckoutId).catch((err) => {
        if (err instanceof CheckoutNotFoundError && event.accountNumber) return null;
        throw err;
      });
      const holding = event.accountNumber
        ? await db.checkout.findMany({
            where: { vaAccountNumber: event.accountNumber, status: 'pending', id: byRef ? { not: byRef } : undefined },
            orderBy: { createdAt: 'asc' },
          })
        : [];
      const checkouts = [...(byRef ? [await db.checkout.findUniqueOrThrow({ where: { id: byRef } })] : []), ...holding];
      if (checkouts.length === 0) throw new CheckoutNotFoundError(event.providerCheckoutId);
      for (const c of checkouts) {
        await confirmReceivedPayment(c, `webhook ${event.eventId}`);
        logger.info({ ...log, ref: c.reference }, 'payment checked with the provider');
      }
      return;
    }
    case 'account.credited':
      // A sweep landing, or money sent straight to the space account: 9jaPay's
      // records say which.
      await refreshSweepsForAccount(event.accountNumber);
      await syncDirectDepositsForAccount(event.accountNumber);
      return;
    case 'transfer.updated': {
      const sweep = await db.sweep.findUnique({ where: { providerReference: event.providerReference }, select: { id: true } });
      if (sweep) {
        await refreshSweep(sweep.id);
        return;
      }
      const payout = await db.payout.findUnique({ where: { providerPayoutId: event.providerReference }, select: { id: true } });
      if (!payout) {
        logger.warn({ ...log, providerReference: event.providerReference }, 'transfer event for nothing we sent');
        return;
      }
      await refreshPayout(payout.id);
      return;
    }
    case 'ignored':
      return;
  }
}

import { type ProviderEvent } from '../types';

/**
 * 9jaPay event → our ProviderEvent (docs.9japay.com/docs/web-hooks).
 *
 *  - new_transaction, Credit, on a checkout's one-time (transient) account
 *    → payment.received. `accountRequestReference` is the reference we
 *    created the account with.
 *  - new_transaction, Credit, on a space's permanent account → account.credited
 *    (a sweep landing).
 *  - transfer_response → transfer.updated. Sent only for transfers that were
 *    PROCESSING when started; `requestReference` is our payment reference.
 *  - Debits and bill_transaction → ignored.
 *
 * None of these is acted on as-is: handlers read the collection or transfer
 * back from 9jaPay. The event doesn't say which kind of account was credited,
 * so space accounts are created with a request reference starting
 * SPACE_ACCOUNT_PREFIX and told apart by it.
 */

export const SPACE_ACCOUNT_PREFIX = 'SPACE';

export class MalformedEventError extends Error {
  constructor(
    public readonly eventId: string | null,
    public readonly eventType: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'MalformedEventError';
  }
}

interface Envelope {
  eventId?: unknown;
  eventType?: unknown;
  data?: Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function normaliseNineJaPayEvent(body: unknown): ProviderEvent {
  const env = (body ?? {}) as Envelope;
  const rawType = str(env.eventType);
  const data = (env.data ?? {}) as Record<string, unknown>;
  // new_transaction samples carry no eventId; the transaction id is unique per event.
  const eventId = str(env.eventId) ?? (rawType ? `${rawType}:${str(data.id) ?? ''}` : null);
  if (!rawType || !eventId || eventId.endsWith(':')) {
    throw new MalformedEventError(str(env.eventId), rawType, 'event is missing an id or type');
  }

  const date = str(data.transactionDate);
  const occurredAt = date && !Number.isNaN(Date.parse(date)) ? new Date(date) : new Date();
  const base = { eventId, rawType, occurredAt };

  switch (rawType) {
    case 'new_transaction': {
      if ((str(data.transactionType) ?? '').toLowerCase() !== 'credit') return { ...base, kind: 'ignored' };
      const accountNumber = str(data.accountNumber);
      const reference = str(data.accountRequestReference);
      if (!accountNumber || !reference) {
        throw new MalformedEventError(eventId, rawType, 'data.accountNumber or data.accountRequestReference is missing');
      }
      if (reference.startsWith(SPACE_ACCOUNT_PREFIX)) return { ...base, kind: 'account.credited', accountNumber };
      return { ...base, kind: 'payment.received', providerCheckoutId: reference };
    }
    case 'transfer_response': {
      const reference = str(data.requestReference) ?? str(data.paymentReference);
      if (!reference) throw new MalformedEventError(eventId, rawType, 'data.requestReference is missing');
      return { ...base, kind: 'transfer.updated', providerReference: reference };
    }
    default:
      return { ...base, kind: 'ignored' };
  }
}

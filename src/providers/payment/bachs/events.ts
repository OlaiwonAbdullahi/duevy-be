import { decimalToKobo } from '../../../lib/money';
import { type ProviderEvent } from '../types';

/**
 * Bachs event envelope → our ProviderEvent. Field names follow the event
 * reference pages under docs.bachs.io/guides/webhooks/events/*.
 *
 * Which events we act on, and why:
 *  - collection.succeeded  status SUCCEEDED | ACCEPTED | OVERPAID → paid.
 *    Bachs: "Fulfill when the payment reaches succeeded, accepted, or overpaid."
 *  - collection.underpaid  → underpaid (amount_paid vs amount_expected).
 *  - collection.failed     status EXPIRED → expired; FAILED → failed.
 *  - checkout.expired      → expired (the session lapsed unpaid).
 *  - checkout.completed    ignored: collection.* is the payment source of truth
 *    and carries the received amount; acting on both would only add noise.
 *  - payout.paid / payout.failed → withdrawal outcome.
 *  - account.updated / capability.updated → re-read the rep's identity state.
 *    Neither carries the verdict itself, so the handler fetches it.
 */

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
  id?: unknown;
  type?: unknown;
  created_at?: unknown;
  organization_id?: unknown;
  account?: unknown;
  data?: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function normaliseBachsEvent(body: unknown): ProviderEvent {
  const env = (body ?? {}) as Envelope;
  const eventId = str(env.id);
  const rawType = str(env.type);
  if (!eventId || !rawType) throw new MalformedEventError(eventId, rawType, 'event is missing id or type');

  const data = (env.data ?? {}) as Record<string, unknown>;
  const createdAt = str(env.created_at);
  const occurredAt = createdAt && !Number.isNaN(Date.parse(createdAt)) ? new Date(createdAt) : new Date();
  const base = { eventId, rawType, occurredAt };

  const amount = (field: string, required = true): number | null => {
    const v = data[field];
    if (v === undefined || v === null || v === '') {
      if (required) throw new MalformedEventError(eventId, rawType, `data.${field} is missing`);
      return null;
    }
    try {
      return decimalToKobo(v as string | number);
    } catch {
      throw new MalformedEventError(eventId, rawType, `data.${field} is not an amount`);
    }
  };

  const reference = str(data.reference);
  const providerCheckoutId = str(data.checkout_id);
  const providerChargeId = str(data.charge_id);
  const status = (str(data.status) ?? '').toUpperCase();

  switch (rawType) {
    case 'collection.succeeded': {
      if (!['SUCCEEDED', 'ACCEPTED', 'OVERPAID'].includes(status)) return { ...base, kind: 'ignored' };
      const received = status === 'OVERPAID' ? amount('received_amount', false) ?? amount('amount') : amount('amount');
      const overpaid = status === 'OVERPAID' ? amount('overpaid_amount', false) ?? 0 : 0;
      return {
        ...base,
        kind: 'payment.succeeded',
        reference,
        providerCheckoutId,
        providerChargeId,
        receivedKobo: received as number,
        overpaidKobo: overpaid,
      };
    }
    case 'collection.underpaid':
      return {
        ...base,
        kind: 'payment.underpaid',
        reference,
        providerCheckoutId,
        providerChargeId,
        receivedKobo: amount('amount_paid') as number,
        expectedKobo: amount('amount_expected') as number,
      };
    case 'collection.failed':
      if (status === 'EXPIRED') return { ...base, kind: 'payment.expired', reference, providerCheckoutId };
      return { ...base, kind: 'payment.failed', reference, providerCheckoutId, reason: str(data.reason) };
    case 'checkout.expired':
      return { ...base, kind: 'payment.expired', reference, providerCheckoutId };
    case 'payout.paid':
      return {
        ...base,
        kind: 'payout.succeeded',
        reference,
        providerPayoutId: str(data.withdrawal_id) ?? str(data.id),
        providerFeeKobo: amount('withdrawal_fee', false),
      };
    case 'payout.failed':
      return {
        ...base,
        kind: 'payout.failed',
        reference,
        providerPayoutId: str(data.withdrawal_id) ?? str(data.id),
        reason: str(data.failure_reason) ?? str(data.reason),
      };
    case 'account.updated':
    case 'capability.updated': {
      const accountId = str(data.account) ?? str(env.account) ?? str(env.organization_id);
      if (!accountId) throw new MalformedEventError(eventId, rawType, 'event names no account');
      return { ...base, kind: 'identity.updated', accountId };
    }
    default:
      return { ...base, kind: 'ignored' };
  }
}

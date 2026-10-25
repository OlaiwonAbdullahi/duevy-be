import { decimalToKobo } from '../../../lib/money';
import { type ProviderEvent } from '../types';

/**
 * Kredi webhook body → our ProviderEvent. Kredi sends bare bodies with no
 * event envelope, so the kind is read from the shape:
 *
 *  - Collection (a payment-link payment): `merchantRef` (our checkout
 *    reference), `amount`, `amountReceived`, `status`, `remitReference`.
 *    status "successful" → paid. Whether it covered the checkout total is
 *    decided by the checkout service, which treats a short amount as underpaid.
 *  - Payout (outward transfer): `merchantReference` (our payout reference),
 *    `krediReference`, `transactionStatus.code` — 200 succeeded, 401 failed;
 *    100 (processing) and 400 (incomplete, Kredi re-queries) are not final.
 *  - Inward transfers to a virtual account carry no reference of ours and are
 *    ignored: Duevy only collects through payment links.
 *
 * The dedupe id is built from Kredi's own references, so a redelivery of the
 * same event collapses to one row.
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

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function when(...values: unknown[]): Date {
  for (const v of values) {
    const s = str(v);
    if (s && !Number.isNaN(Date.parse(s))) return new Date(s);
  }
  return new Date();
}

export function normaliseKrediEvent(body: unknown): ProviderEvent {
  const b = (body ?? {}) as Record<string, unknown>;

  const krediReference = str(b.krediReference);
  const payoutReference = str(b.merchantReference) ?? str(b.yourReference);
  if (krediReference || (payoutReference && (b.transactionStatus || b.transactionAmount !== undefined))) {
    return normalisePayout(b, payoutReference, krediReference);
  }

  const remitReference = str(b.remitReference) ?? str(b.sessionId);
  if (str(b.accountType)?.toLowerCase() === 'collection' || str(b.merchantRef)) {
    return normaliseCollection(b, remitReference);
  }

  if (remitReference) {
    return { eventId: `inward:${remitReference}`, rawType: 'inward', occurredAt: when(b.createdAt), kind: 'ignored' };
  }
  throw new MalformedEventError(null, null, 'webhook body is neither a collection nor a payout');
}

function normaliseCollection(b: Record<string, unknown>, remitReference: string | null): ProviderEvent {
  const rawType = 'collection';
  if (!remitReference) throw new MalformedEventError(null, rawType, 'collection has no remitReference');
  const eventId = `collection:${remitReference}`;
  const base = { eventId, rawType, occurredAt: when(b.receivedAt, b.createdAt) };

  const reference = str(b.merchantRef);
  if (!reference) return { ...base, kind: 'ignored' };

  const status = (str(b.status) ?? '').toLowerCase();
  if (status === 'expired') return { ...base, kind: 'payment.expired', reference, providerCheckoutId: reference };
  if (status !== 'successful' && status !== 'success') return { ...base, kind: 'ignored' };

  const rawAmount = b.amountReceived ?? b.amount;
  if (rawAmount === null || rawAmount === undefined || rawAmount === '') {
    throw new MalformedEventError(eventId, rawType, 'collection has no amount');
  }
  let receivedKobo: number;
  try {
    receivedKobo = decimalToKobo(rawAmount as string | number);
  } catch {
    throw new MalformedEventError(eventId, rawType, 'collection amount is not an amount');
  }
  return {
    ...base,
    kind: 'payment.succeeded',
    reference,
    providerCheckoutId: reference,
    // One transfer into the checkout; a second, different one is a second payment.
    providerChargeId: remitReference,
    receivedKobo,
    overpaidKobo: 0,
  };
}

function normalisePayout(b: Record<string, unknown>, reference: string | null, krediReference: string | null): ProviderEvent {
  const rawType = 'payout';
  const statusObj = (b.transactionStatus ?? b.status) as { code?: unknown; status_message?: unknown } | undefined;
  const code = Number(typeof statusObj === 'object' && statusObj ? statusObj.code : NaN);
  if (!reference) throw new MalformedEventError(krediReference ? `payout:${krediReference}` : null, rawType, 'payout has no merchantReference');
  const eventId = `payout:${reference}:${Number.isFinite(code) ? code : 'unknown'}`;
  const base = { eventId, rawType, occurredAt: when(b.createdAt, b.created_at) };

  if (code === 200) {
    return { ...base, kind: 'payout.succeeded', reference, providerPayoutId: krediReference, providerFeeKobo: null };
  }
  if (code === 401) {
    const reason = str(b.transactionStatusMessage) ?? str(b.transaction_status_message) ?? str(statusObj?.status_message);
    return { ...base, kind: 'payout.failed', reference, providerPayoutId: krediReference, reason };
  }
  return { ...base, kind: 'ignored' };
}

import { logger } from '../../../lib/logger';
import { decimalToKobo } from '../../../lib/money';
import { MalformedEventError, type ProviderEvent } from '../types';
import { isValidTransactionHash } from './signature';

/**
 * Bank78 event envelope → our ProviderEvent. Payloads per the Webhooks page,
 * merchant API version 2 and later: `{ "eventType": ..., "data": { ... } }`.
 * Version 1 sends the bare `data` object with no type; the merchant profile
 * must be on v2 or we could not tell events apart, so a bare body is malformed.
 *
 * Bank78 sends no event id. Each event's stable reference is the dedupe key:
 * a collection's sessionId, a transfer's reference, a refund's refundReference.
 *
 * Which events we act on:
 *  - virtual-nuban-transaction-credit → paid. The accountReference is our
 *    checkout reference; the dynamic account was opened for the exact total.
 *  - transfer.success → a withdrawal succeeded (with Bank78's fee).
 * Everything else is acknowledged and ignored:
 *  - virtual-nuban-transaction-acknowledgement: a notice, not the credit.
 *  - virtual-nuban-transaction.failed: Bank78 refused a transfer of the wrong
 *    amount (accounts are opened Exact), so the money never arrived and the
 *    checkout stays open for a correct transfer.
 *  - sub-account-credit-success: the credit our own routing transfer made.
 *  - refunds, name enquiries and FX funding: not flows Duevy starts.
 */

interface Envelope {
  eventType?: unknown;
  data?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface NormaliseOptions {
  /** Our Bank78 client secret, which keys the transactionHash on payment events. */
  clientSecret?: string;
}

export function normaliseBank78Event(body: unknown, opts: NormaliseOptions = {}): ProviderEvent {
  const env = (body ?? {}) as Envelope;
  const rawType = str(env.eventType);
  if (!rawType || typeof env.data !== 'object' || env.data === null) {
    throw new MalformedEventError(null, rawType, 'event has no eventType/data envelope — set the merchant webhook to API version 2');
  }
  const data = env.data as Record<string, unknown>;

  const key = str(data.refundReference) ?? str(data.sessionId) ?? str(data.reference) ?? str(data.requestId);
  if (!key) throw new MalformedEventError(null, rawType, 'event has no sessionId, reference or refundReference');
  const eventId = `${rawType}:${key}`;

  const when = str(data.completedAtUtc) ?? str(data.paymentDate) ?? str(data.transactionDate) ?? str(data.completedAt);
  // Bank78 date-times are UTC unless an offset is given.
  const parsed = when ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(when) ? when : `${when}Z`) : NaN;
  const base = { eventId, rawType, occurredAt: Number.isNaN(parsed) ? new Date() : new Date(parsed) };

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

  switch (rawType) {
    case 'virtual-nuban-transaction-credit': {
      const sessionId = str(data.sessionId) as string;
      const receivedKobo = amount('amount') as number;
      const hash = str(data.transactionHash);
      const paymentDate = str(data.paymentDate);
      // The signature already authenticates the delivery; the hash is a second
      // check whose exact formatting hasn't been confirmed against live traffic,
      // so a mismatch is flagged rather than allowed to drop a real payment.
      if (opts.clientSecret && hash && paymentDate) {
        if (!isValidTransactionHash(opts.clientSecret, sessionId, receivedKobo / 100, paymentDate, hash)) {
          logger.warn({ eventId, ref: str(data.accountReference) }, 'bank78 transactionHash did not match');
        }
      }
      return {
        ...base,
        kind: 'payment.succeeded',
        reference: str(data.accountReference),
        providerCheckoutId: str(data.accountReference),
        providerChargeId: sessionId,
        receivedKobo,
        overpaidKobo: 0,
      };
    }
    case 'transfer.success':
      return {
        ...base,
        kind: 'payout.succeeded',
        reference: str(data.reference),
        providerPayoutId: str(data.reference),
        providerFeeKobo: amount('fee', false),
      };
    default:
      return { ...base, kind: 'ignored' };
  }
}

import { type ProviderEvent } from '../types';
// Reuse the one MalformedEventError the webhook route matches with instanceof
// (re-exported from src/providers/payment/index.ts).
import { MalformedEventError } from '../ninejapay/events';

/**
 * Interswitch webhook → our ProviderEvent (docs.interswitchgroup.com/docs/webhooks).
 *
 * The dashboard sends a few event categories (Transactions, Payout, …) and the
 * exact field names are confirmed per-merchant in the portal, so this parser is
 * deliberately tolerant: it reads the common field spellings and classifies
 * best-effort. Anything it can't place becomes `ignored` — safe, because every
 * handler requeries Interswitch and reconciliation is the backstop.
 *
 *   - A transaction naming our merchant/txn reference → payment.received
 *     (a student's card checkout; providerCheckoutId = that reference).
 *   - A credit into a space's virtual account → account.credited.
 *   - A payout status change → transfer.updated.
 */

export interface NormaliseOptions {
  /** Our space accounts carry this request-reference prefix (see InterswitchProvider). */
  spaceAccountPrefix?: string;
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** First non-empty string among several candidate keys (case handled by caller). */
function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v) return v;
  }
  return null;
}

function parseDate(raw: string | null): Date {
  if (!raw) return new Date();
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? new Date() : new Date(ms);
}

export function normaliseInterswitchEvent(body: unknown, opts: NormaliseOptions = {}): ProviderEvent {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = ((root.data ?? root.payload ?? root.transaction ?? root) as Record<string, unknown>) ?? {};

  const rawType =
    pick(root, ['eventType', 'event', 'type', 'notificationType']) ??
    pick(data, ['eventType', 'event', 'type']) ??
    'transaction';

  const merchantRef = pick(data, ['merchantReference', 'merchantTransactionReference', 'transactionReference', 'txnRef', 'merchant_reference']);
  const paymentRef = pick(data, ['paymentReference', 'transactionId', 'id', 'retrievalReferenceNumber', 'rrn']);
  const accountNumber = pick(data, ['virtualAccountNumber', 'accountNumber', 'account_number', 'accountNo']);

  const eventId =
    pick(root, ['eventId', 'id', 'notificationId']) ??
    paymentRef ??
    merchantRef ??
    (accountNumber ? `${rawType}:${accountNumber}` : null);
  if (!eventId) throw new MalformedEventError(null, rawType, 'event is missing any id or reference');

  const occurredAt = parseDate(pick(data, ['transactionDate', 'paymentDate', 'date', 'createdAt']));
  const base = { eventId, rawType, occurredAt };

  const lowered = rawType.toLowerCase();

  // Payout / transfer status changes.
  if (lowered.includes('payout') || lowered.includes('transfer') || lowered.includes('disburse')) {
    const reference = pick(data, ['merchantReference', 'transactionReference', 'reference', 'requestReference']) ?? paymentRef;
    if (!reference) return { ...base, kind: 'ignored' };
    return { ...base, kind: 'transfer.updated', providerReference: reference };
  }

  // A credit landing in a space's permanent virtual account.
  if (accountNumber && !merchantRef) {
    return { ...base, kind: 'account.credited', accountNumber };
  }

  // A student's card checkout completing (named by our merchant/txn reference).
  if (merchantRef) {
    if (opts.spaceAccountPrefix && merchantRef.startsWith(opts.spaceAccountPrefix)) {
      return { ...base, kind: accountNumber ? 'account.credited' : 'ignored', accountNumber: accountNumber ?? '' } as ProviderEvent;
    }
    return { ...base, kind: 'payment.received', providerCheckoutId: merchantRef, ...(accountNumber ? { accountNumber } : {}) };
  }

  return { ...base, kind: 'ignored' };
}

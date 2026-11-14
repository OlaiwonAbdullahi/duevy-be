import { createHmac, timingSafeEqual } from 'crypto';
import { MalformedEventError, type ProviderEvent } from '../types';

/**
 * Wire format for the FakeProvider (tests only). It is a simple, self-contained
 * webhook shape and HMAC scheme so the integration suite can post signed events
 * and exercise the same webhook → ProviderEvent path the real providers use.
 * Not a real payment rail.
 *
 * Signature: base64( HMAC-SHA256(secret, raw body) ) in the `Signature` header.
 * Space (permanent) accounts are told apart from one-time checkout accounts by a
 * request reference starting SPACE_ACCOUNT_PREFIX.
 */

export const SPACE_ACCOUNT_PREFIX = 'SPACE';

export function computeFakeSignature(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export interface SignatureCheck {
  ok: boolean;
  reason?: 'missing' | 'mismatch';
}

export function verifyFakeSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: string[],
): SignatureCheck {
  const usable = secrets.filter(Boolean);
  const given = header(headers, 'signature')?.trim();
  if (usable.length === 0 || !given) return { ok: false, reason: 'missing' };

  const givenBytes = Buffer.from(given);
  for (const secret of usable) {
    const expected = Buffer.from(computeFakeSignature(secret, rawBody));
    if (expected.length === givenBytes.length && timingSafeEqual(expected, givenBytes)) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

/** Lagos wall-clock timestamps with no offset are read as UTC+1 unless they carry their own. */
function parseFakeDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const ms = Date.parse(hasOffset ? raw : `${raw.replace(/(\.\d{3})\d+$/, '$1')}+01:00`);
  return Number.isNaN(ms) ? null : new Date(ms);
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

export interface NormaliseOptions {
  /** Duevy's own business (collection) account; movements on it are ignored. */
  businessAccountNumber?: string;
}

export function normaliseFakeEvent(body: unknown, opts: NormaliseOptions = {}): ProviderEvent {
  const env = (body ?? {}) as Envelope;
  const rawType = str(env.eventType);
  const data = (env.data ?? {}) as Record<string, unknown>;
  const eventId = str(env.eventId) ?? (rawType ? `${rawType}:${str(data.id) ?? ''}` : null);
  if (!rawType || !eventId || eventId.endsWith(':')) {
    throw new MalformedEventError(str(env.eventId), rawType, 'event is missing an id or type');
  }

  const occurredAt = parseFakeDate(str(data.transactionDate)) ?? new Date();
  const base = { eventId, rawType, occurredAt };

  switch (rawType) {
    case 'new_transaction': {
      if ((str(data.transactionType) ?? '').toLowerCase() !== 'credit') return { ...base, kind: 'ignored' };
      const accountNumber = str(data.accountNumber);
      if (accountNumber && accountNumber === opts.businessAccountNumber) return { ...base, kind: 'ignored' };
      const reference = str(data.accountRequestReference);
      if (!accountNumber || !reference) {
        throw new MalformedEventError(eventId, rawType, 'data.accountNumber or data.accountRequestReference is missing');
      }
      if (reference.startsWith(SPACE_ACCOUNT_PREFIX)) return { ...base, kind: 'account.credited', accountNumber };
      return { ...base, kind: 'payment.received', providerCheckoutId: reference, accountNumber };
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

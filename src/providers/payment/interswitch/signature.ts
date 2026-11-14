import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Interswitch webhook signature check.
 *
 * Interswitch's dashboard webhooks carry a signature header; the exact scheme
 * is confirmed per-merchant in the Quickteller Business portal. We verify an
 * HMAC-SHA256 of the raw body under the configured secret, accepting either a
 * base64 or hex digest and any of the common header names.
 *
 * The webhook is only a NUDGE: every handler requeries Interswitch
 * (gettransaction.json / payout status) before moving money, and each event is
 * deduplicated by id. So in the TEST environment, when no secret is configured
 * (Interswitch sandbox deliveries are often unsigned), we accept the event and
 * rely on that requery. In LIVE a secret is required.
 */

const SIGNATURE_HEADERS = ['x-interswitch-signature', 'x-isw-signature', 'signature', 'x-signature'];

export interface SignatureCheck {
  ok: boolean;
  reason?: 'missing' | 'mismatch' | 'unsigned-test';
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function givenSignature(headers: Record<string, string | string[] | undefined>): string | undefined {
  for (const name of SIGNATURE_HEADERS) {
    const v = header(headers, name)?.trim();
    if (v) return v;
  }
  return undefined;
}

function equals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyInterswitchSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  env: 'test' | 'live',
): SignatureCheck {
  const given = givenSignature(headers);

  if (!secret) {
    // No secret configured: only tolerated in TEST, where handlers requery.
    return env === 'test' ? { ok: true, reason: 'unsigned-test' } : { ok: false, reason: 'missing' };
  }
  if (!given) return env === 'test' ? { ok: true, reason: 'unsigned-test' } : { ok: false, reason: 'missing' };

  const hmac = createHmac('sha256', secret).update(rawBody);
  const digest = hmac.digest();
  if (equals(given, digest.toString('base64')) || equals(given.toLowerCase(), digest.toString('hex'))) {
    return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * The emailed "see my receipts" link carries a signed, short-lived token that
 * names the email it was sent to. Holding it proves access to that inbox, so
 * the public receipts page never shows anything for an email typed in alone.
 *
 * Format: base64url(JSON {e, x}) + "." + base64url(HMAC-SHA256).
 */
const TTL_MS = 60 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(`receipt-access:${payload}`).digest('base64url');
}

export function createReceiptAccessToken(email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email.trim().toLowerCase(), x: now + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The email the token was issued for, or null when it's forged, malformed or expired. */
export function readReceiptAccessToken(token: string, now = Date.now()): string | null {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { e?: unknown; x?: unknown };
    if (typeof e !== 'string' || typeof x !== 'number' || x < now) return null;
    return e;
  } catch {
    return null;
  }
}

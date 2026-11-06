import { createHmac, timingSafeEqual } from 'crypto';

/**
 * 9jaPay webhook signatures (docs.9japay.com/docs/web-hooks):
 *
 *   Signature: base64( HMAC-SHA256(SECRET_KEY, raw body) )
 *
 * There is no timestamp, so a captured delivery could be replayed. That is
 * acceptable only because every event is deduplicated by its id and handlers
 * confirm with the provider before changing anything.
 */

export function computeNineJaPaySignature(secret: string, rawBody: Buffer | string): string {
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

export function verifyNineJaPaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: string[],
): SignatureCheck {
  const usable = secrets.filter(Boolean);
  const given = header(headers, 'signature')?.trim();
  if (usable.length === 0 || !given) return { ok: false, reason: 'missing' };

  const givenBytes = Buffer.from(given);
  for (const secret of usable) {
    const expected = Buffer.from(computeNineJaPaySignature(secret, rawBody));
    if (expected.length === givenBytes.length && timingSafeEqual(expected, givenBytes)) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

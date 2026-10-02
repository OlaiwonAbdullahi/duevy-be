import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Bachs webhook signatures (docs.bachs.io/guides/webhooks/overview):
 *
 *   X-Bachs-Signature-V2: t=<unix seconds>,v1=<hex>[,v1=<hex>…]   (preferred)
 *   X-Bachs-Signature:    <hex>  with  X-Bachs-Timestamp: <unix seconds>
 *
 * Each <hex> is HMAC-SHA256(endpoint secret, "<t>.<raw body>"). During a
 * secret rotation the V2 header carries one v1 per valid secret, so a delivery
 * is accepted when ANY v1 matches ANY secret we hold. The timestamp is bound
 * into the MAC, and deliveries outside the tolerance window are rejected so a
 * captured request cannot be replayed later.
 */

export function computeBachsSignature(secret: string, timestamp: string | number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export interface SignatureCheck {
  ok: boolean;
  reason?: 'missing' | 'malformed' | 'stale' | 'mismatch';
}

export function verifyBachsSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: string[],
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureCheck {
  const usable = secrets.filter(Boolean);
  if (usable.length === 0) return { ok: false, reason: 'missing' };

  let timestamp: string | undefined;
  let candidates: string[] = [];

  const v2 = header(headers, 'x-bachs-signature-v2');
  if (v2) {
    for (const part of v2.split(',')) {
      const [k, ...rest] = part.trim().split('=');
      const v = rest.join('=');
      if (k === 't') timestamp = v;
      else if (k === 'v1' && v) candidates.push(v);
    }
  } else {
    const legacy = header(headers, 'x-bachs-signature');
    timestamp = header(headers, 'x-bachs-timestamp');
    if (legacy) candidates = [legacy.trim()];
  }

  if (!timestamp && candidates.length === 0) return { ok: false, reason: 'missing' };
  if (!timestamp || !/^\d+$/.test(timestamp) || candidates.length === 0) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'stale' };

  for (const secret of usable) {
    const expected = computeBachsSignature(secret, timestamp, rawBody);
    if (candidates.some((c) => safeEqualHex(c, expected))) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

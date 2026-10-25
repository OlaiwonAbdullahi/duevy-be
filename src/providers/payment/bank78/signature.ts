import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Bank78 webhook signatures (Webhooks page):
 *
 *   X-Bank78-Webhook-Timestamp:         <unix seconds>
 *   X-Bank78-Webhook-Signature-Version: v1
 *   X-Bank78-Webhook-Signature:         <lowercase hex>
 *
 * The signature is HMAC-SHA256(webhook secret, "<timestamp>.<raw body>"). The
 * timestamp is bound into the MAC, and deliveries outside the tolerance window
 * are rejected so a captured request cannot be replayed later. During a
 * rotation a delivery is accepted under either the current or previous secret.
 */

export function computeBank78Signature(secret: string, timestamp: string | number, rawBody: Buffer | string): string {
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

export function verifyBank78Signature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: string[],
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureCheck {
  const usable = secrets.filter(Boolean);
  if (usable.length === 0) return { ok: false, reason: 'missing' };

  const signature = header(headers, 'x-bank78-webhook-signature')?.trim();
  const timestamp = header(headers, 'x-bank78-webhook-timestamp')?.trim();
  const version = header(headers, 'x-bank78-webhook-signature-version')?.trim();

  if (!signature && !timestamp) return { ok: false, reason: 'missing' };
  if (!signature || !timestamp || !/^\d+$/.test(timestamp) || (version && version !== 'v1')) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'stale' };

  for (const secret of usable) {
    if (safeEqualHex(signature, computeBank78Signature(secret, timestamp, rawBody))) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * The `transactionHash` on payment events: lowercase SHA-512 of
 * `clientSecret|sessionId|amount|paymentDate|sessionId`, with the amount to two
 * decimals and the date as yyyy-MM-ddTHH:mm:ss. A second, independent proof
 * that the credit came from Bank78, keyed by our API client secret.
 */
export function computeTransactionHash(clientSecret: string, sessionId: string, amount: number, paymentDate: string): string {
  const date = paymentDate.slice(0, 19);
  return createHash('sha512').update(`${clientSecret}|${sessionId}|${amount.toFixed(2)}|${date}|${sessionId}`).digest('hex');
}

export function isValidTransactionHash(clientSecret: string, sessionId: string, amount: number, paymentDate: string, hash: string): boolean {
  return safeEqualHex(hash.toLowerCase(), computeTransactionHash(clientSecret, sessionId, amount, paymentDate));
}

import { createHash, timingSafeEqual } from 'crypto';

/**
 * Kredi webhook signatures (documentation.thekredibank.com — Collection,
 * Inward and Payout webhooks):
 *
 *   signature-key: SHA-512 hex of "<amount>-<secret>-<reference>"
 *
 *  - Collection / inward: amount = the amount received, reference = remitReference.
 *  - Payout (outward):    amount = transactionAmount,   reference = merchantReference.
 *
 * The docs don't pin down how the amount is rendered in the hashed string (a
 * collection sends "2.00", a payout sends the number 1), so each plausible
 * rendering is tried. There is no timestamp in the scheme: replays are stopped
 * by deduplicating on the event id and by the idempotent handlers behind it.
 */

export function computeKrediSignature(amount: string, secret: string, reference: string): string {
  return createHash('sha512').update(`${amount}-${secret}-${reference}`).digest('hex');
}

function header(headers: Record<string, string | string[] | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    const first = Array.isArray(value) ? value[0] : value;
    if (first) return first.trim();
  }
  return undefined;
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

/** "2.00" → ["2.00", "2"], 1 → ["1", "1.00"]. */
function amountRenderings(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return [];
  const raw = String(value).trim();
  const n = Number(raw);
  const out = new Set([raw]);
  if (Number.isFinite(n)) {
    out.add(String(n));
    out.add(n.toFixed(2));
  }
  return [...out];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
}

export interface SignatureCheck {
  ok: boolean;
  reason?: 'missing' | 'malformed' | 'mismatch';
}

export function verifyKrediSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: string[],
): SignatureCheck {
  const usable = secrets.filter(Boolean);
  const given = header(headers, 'signature-key', 'signature');
  if (!given || usable.length === 0) return { ok: false, reason: 'missing' };

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'malformed' };

  const references = [str(body.remitReference), str(body.merchantReference)].filter((r): r is string => !!r);
  const amounts = [
    ...amountRenderings(body.amountReceived),
    ...amountRenderings(body.amount),
    ...amountRenderings(body.transactionAmount),
  ];
  if (references.length === 0 || amounts.length === 0) return { ok: false, reason: 'malformed' };

  for (const secret of usable) {
    for (const reference of references) {
      for (const amount of amounts) {
        if (safeEqualHex(given, computeKrediSignature(amount, secret, reference))) return { ok: true };
      }
    }
  }
  return { ok: false, reason: 'mismatch' };
}

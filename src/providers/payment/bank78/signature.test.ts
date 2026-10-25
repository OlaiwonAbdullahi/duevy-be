import { describe, expect, it } from 'vitest';
import { computeBank78Signature, computeTransactionHash, isValidTransactionHash, verifyBank78Signature } from './signature';

const secret = 'whsec_test_secret';
const body = Buffer.from(JSON.stringify({ eventType: 'transfer.success', data: { reference: 'WD-2026-ABC123' } }));
const now = 1_760_000_000;

function headers(sig: string, ts: number | string = now) {
  return {
    'x-bank78-webhook-timestamp': String(ts),
    'x-bank78-webhook-signature-version': 'v1',
    'x-bank78-webhook-signature': sig,
  };
}

describe('verifyBank78Signature', () => {
  it('accepts HMAC-SHA256 of "timestamp.rawBody"', () => {
    expect(verifyBank78Signature(body, headers(computeBank78Signature(secret, now, body)), [secret], 300, now)).toEqual({ ok: true });
  });

  it('matches the docs’ reference implementation', async () => {
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', secret).update(`${now}.${body.toString('utf8')}`, 'utf8').digest('hex');
    expect(computeBank78Signature(secret, now, body)).toBe(expected);
  });

  it('rejects a tampered body', () => {
    const sig = computeBank78Signature(secret, now, body);
    expect(verifyBank78Signature(Buffer.from(`${body.toString()} `), headers(sig), [secret], 300, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a delivery outside the tolerance window', () => {
    const old = now - 301;
    expect(verifyBank78Signature(body, headers(computeBank78Signature(secret, old, body), old), [secret], 300, now)).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts the previous secret during a rotation', () => {
    const sig = computeBank78Signature('whsec_old', now, body);
    expect(verifyBank78Signature(body, headers(sig), [secret, 'whsec_old'], 300, now).ok).toBe(true);
  });

  it('rejects missing, malformed and unknown-version signatures', () => {
    expect(verifyBank78Signature(body, {}, [secret], 300, now)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyBank78Signature(body, headers('abc', 'yesterday'), [secret], 300, now)).toEqual({ ok: false, reason: 'malformed' });
    const sig = computeBank78Signature(secret, now, body);
    expect(verifyBank78Signature(body, { ...headers(sig), 'x-bank78-webhook-signature-version': 'v2' }, [secret], 300, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyBank78Signature(body, headers(sig), [], 300, now)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('transactionHash', () => {
  it('is SHA-512 of clientSecret|sessionId|amount|paymentDate|sessionId, two-decimal amount, seconds precision', () => {
    const hash = computeTransactionHash('cs', 'S1', 2500, '2026-08-19T14:15:16.927512');
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
    expect(hash).toBe(computeTransactionHash('cs', 'S1', 2500.0, '2026-08-19T14:15:16'));
    expect(isValidTransactionHash('cs', 'S1', 2500, '2026-08-19T14:15:16', hash.toUpperCase())).toBe(true);
    expect(isValidTransactionHash('cs', 'S1', 2500.01, '2026-08-19T14:15:16', hash)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { computeBachsSignature, verifyBachsSignature } from './signature';

const SECRET = 'whsec_current';
const OLD = 'whsec_previous';
const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'collection.succeeded', data: { amount: '5120.00' } }));
const now = 1_790_000_000;

describe('verifyBachsSignature', () => {
  it('accepts a valid V2 signature', () => {
    const sig = computeBachsSignature(SECRET, now, body);
    const r = verifyBachsSignature(body, { 'x-bachs-signature-v2': `t=${now},v1=${sig}` }, [SECRET], 300, now);
    expect(r.ok).toBe(true);
  });

  it('accepts when any v1 matches any held secret (rotation window)', () => {
    const oldSig = computeBachsSignature(OLD, now, body);
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${oldSig}`;
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': header }, [SECRET, OLD], 300, now).ok).toBe(true);
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': header }, [SECRET], 300, now).ok).toBe(false);
  });

  it('accepts the legacy header pair', () => {
    const sig = computeBachsSignature(SECRET, now, body);
    const r = verifyBachsSignature(body, { 'x-bachs-signature': sig, 'x-bachs-timestamp': String(now) }, [SECRET], 300, now);
    expect(r.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = computeBachsSignature(SECRET, now, body);
    const tampered = Buffer.from(body.toString().replace('5120.00', '9999.00'));
    expect(verifyBachsSignature(tampered, { 'x-bachs-signature-v2': `t=${now},v1=${sig}` }, [SECRET], 300, now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a timestamp outside the tolerance (replay)', () => {
    const t = now - 301;
    const sig = computeBachsSignature(SECRET, t, body);
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': `t=${t},v1=${sig}` }, [SECRET], 300, now).reason).toBe('stale');
  });

  it('binds the timestamp into the MAC', () => {
    const sig = computeBachsSignature(SECRET, now, body);
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': `t=${now + 1},v1=${sig}` }, [SECRET], 300, now).ok).toBe(false);
  });

  it('rejects missing, malformed and unconfigured cases', () => {
    expect(verifyBachsSignature(body, {}, [SECRET], 300, now).reason).toBe('missing');
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': 'v1=abc' }, [SECRET], 300, now).reason).toBe('malformed');
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': `t=${now},v1=zz` }, [SECRET], 300, now).reason).toBe('mismatch');
    expect(verifyBachsSignature(body, { 'x-bachs-signature-v2': `t=${now},v1=ab` }, [], 300, now).reason).toBe('missing');
  });
});

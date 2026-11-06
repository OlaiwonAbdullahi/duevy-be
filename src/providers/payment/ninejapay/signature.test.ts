import { describe, expect, it } from 'vitest';
import { computeNineJaPaySignature, verifyNineJaPaySignature } from './signature';

const SECRET = 'sk_test_secret';
const body = Buffer.from('{"eventType":"transfer_response","data":{"requestReference":"WD2026ABCDEF","status":"Success"}}');

describe('9jaPay webhook signature — base64 HMAC-SHA256 of the raw body', () => {
  it('accepts the signature 9jaPay would send', () => {
    const sig = computeNineJaPaySignature(SECRET, body);
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verifyNineJaPaySignature(body, { signature: sig }, [SECRET])).toEqual({ ok: true });
  });

  it('reads the header case-insensitively as Node delivers it', () => {
    expect(verifyNineJaPaySignature(body, { Signature: computeNineJaPaySignature(SECRET, body) }, [SECRET]).ok).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a missing header', () => {
    const sig = computeNineJaPaySignature(SECRET, body);
    expect(verifyNineJaPaySignature(Buffer.from(body.toString().replace('Success', 'Failed')), { signature: sig }, [SECRET])).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyNineJaPaySignature(body, { signature: sig }, ['other'])).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyNineJaPaySignature(body, {}, [SECRET])).toEqual({ ok: false, reason: 'missing' });
    expect(verifyNineJaPaySignature(body, { signature: sig }, [])).toEqual({ ok: false, reason: 'missing' });
  });
});

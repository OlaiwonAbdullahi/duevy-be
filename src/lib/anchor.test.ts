import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { computeWebhookSignature, fromAnchorRef, toAnchorRef, verifyWebhookSignature } from './anchor';

const SECRET = 'whsec12345'; // matches src/test/setup.ts
const BODY = Buffer.from('{"id":"evt_1","type":"payment.received"}', 'utf8');

describe('webhook signature', () => {
  it('base64-encodes the HEX DIGEST, not the raw digest bytes', () => {
    // Pinned against Anchor's own Python reference implementation:
    //   hexdigest = hmac.new(secret, payload, sha1).hexdigest()
    //   base64.b64encode(hexdigest.encode())
    expect(computeWebhookSignature(BODY, SECRET)).toBe(
      'Y2Y1YjhkNGJmZDM5OGRkM2Q4NzY3NzdmMjQyMjAwNGU2ZDlmYjkzYg==',
    );
  });

  it('differs from the conventional base64(digest) — the mistake that rejects every real webhook', () => {
    const naive = createHmac('sha1', SECRET).update(BODY).digest('base64');
    expect(naive).toBe('z1uNS/05jdPYdnd/JCIATm2fuTs=');
    expect(computeWebhookSignature(BODY, SECRET)).not.toBe(naive);
  });

  it('accepts a correctly signed body', () => {
    expect(verifyWebhookSignature(BODY, computeWebhookSignature(BODY, SECRET))).toBe(true);
  });

  it('rejects a tampered body, a wrong key, a missing header and a length mismatch', () => {
    const good = computeWebhookSignature(BODY, SECRET);
    expect(verifyWebhookSignature(Buffer.from('{"id":"evt_2"}'), good)).toBe(false);
    expect(verifyWebhookSignature(BODY, computeWebhookSignature(BODY, 'otherkey'))).toBe(false);
    expect(verifyWebhookSignature(BODY, undefined)).toBe(false);
    expect(verifyWebhookSignature(BODY, '')).toBe(false);
    expect(verifyWebhookSignature(BODY, good.slice(0, -4))).toBe(false);
  });
});

describe('references', () => {
  it('lowercases our references for Anchor and restores them coming back', () => {
    expect(toAnchorRef('DVY-4821-7735')).toBe('dvy-4821-7735');
    expect(fromAnchorRef('dvy-4821-7735')).toBe('DVY-4821-7735');
    expect(fromAnchorRef(toAnchorRef('PAY-2026-0642'))).toBe('PAY-2026-0642');
  });

  it('accepts every reference shape our generators actually emit', () => {
    for (const ref of ['DVY-1234-5678', 'PAY-2026-0642', `DVY-${Date.now()}`, 'swp-dvy-1234-5678']) {
      expect(() => toAnchorRef(ref)).not.toThrow();
      expect(toAnchorRef(ref)).toMatch(/^[a-z\d\-_\s]+$/);
    }
  });

  it('refuses a reference Anchor would reject rather than sending it', () => {
    // Anchor's pattern allows only [a-z0-9-_ ]; anything else has to fail loudly
    // at our boundary, not as an opaque 400 mid-payment.
    expect(() => toAnchorRef('DVY/4821')).toThrow(/cannot be represented/);
    expect(() => toAnchorRef('DVY.4821')).toThrow(/cannot be represented/);
    expect(() => toAnchorRef('DVY#4821')).toThrow(/cannot be represented/);
  });
});

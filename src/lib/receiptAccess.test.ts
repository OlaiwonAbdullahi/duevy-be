import { describe, expect, it } from 'vitest';
import { createReceiptAccessToken, readReceiptAccessToken } from './receiptAccess';

describe('receipt access tokens', () => {
  it('round-trips the (normalised) email', () => {
    const t = createReceiptAccessToken('  Ada@Example.com ');
    expect(readReceiptAccessToken(t)).toBe('ada@example.com');
  });

  it('rejects an expired token', () => {
    const t = createReceiptAccessToken('ada@example.com', Date.now() - 2 * 60 * 60 * 1000);
    expect(readReceiptAccessToken(t)).toBeNull();
  });

  it('rejects a token whose email was swapped', () => {
    const t = createReceiptAccessToken('ada@example.com');
    const [, sig] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ e: 'bob@example.com', x: Date.now() + 60_000 })).toString('base64url')}.${sig}`;
    expect(readReceiptAccessToken(forged)).toBeNull();
  });

  it('rejects junk', () => {
    expect(readReceiptAccessToken('')).toBeNull();
    expect(readReceiptAccessToken('a.b.c')).toBeNull();
    expect(readReceiptAccessToken('nope')).toBeNull();
  });
});

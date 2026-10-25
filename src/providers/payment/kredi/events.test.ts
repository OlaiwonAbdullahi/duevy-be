import { describe, expect, it } from 'vitest';
import { MalformedEventError, normaliseKrediEvent } from './events';

describe('normaliseKrediEvent — collections', () => {
  const base = {
    merchantRef: 'DVY-7KQ2-MN4X',
    amount: '5095.00',
    amountReceived: '5095.00',
    status: 'successful',
    remitReference: '0123456789',
    accountType: 'collection',
    receivedAt: '2026-10-24T10:00:00.000Z',
  };

  it('turns a successful collection into payment.succeeded, keyed by remitReference', () => {
    const e = normaliseKrediEvent(base);
    expect(e).toMatchObject({
      kind: 'payment.succeeded',
      eventId: 'collection:0123456789',
      reference: 'DVY-7KQ2-MN4X',
      providerCheckoutId: 'DVY-7KQ2-MN4X',
      providerChargeId: '0123456789',
      receivedKobo: 509_500,
      overpaidKobo: 0,
    });
    expect(e.occurredAt.toISOString()).toBe('2026-10-24T10:00:00.000Z');
  });

  it('falls back to `amount` when amountReceived is null (as in the docs sample)', () => {
    expect(normaliseKrediEvent({ ...base, amountReceived: null, amount: '2.00' })).toMatchObject({ receivedKobo: 200 });
  });

  it('ignores non-final statuses and collections that are not ours', () => {
    expect(normaliseKrediEvent({ ...base, status: 'pending' }).kind).toBe('ignored');
    expect(normaliseKrediEvent({ ...base, status: 'expired' }).kind).toBe('ignored');
    expect(normaliseKrediEvent({ ...base, merchantRef: undefined, accountType: 'collection' }).kind).toBe('ignored');
  });

  it('ignores an inward transfer to a virtual account', () => {
    expect(normaliseKrediEvent({ remitReference: '99', amount: 1, accountType: 'Merchant' })).toMatchObject({ kind: 'ignored', eventId: 'inward:99' });
  });

  it('refuses a successful collection with no amount', () => {
    expect(() => normaliseKrediEvent({ ...base, amount: null, amountReceived: null })).toThrow(MalformedEventError);
  });
});

describe('normaliseKrediEvent — payouts', () => {
  const base = {
    krediReference: 'KRDM_99980491533b',
    merchantReference: 'WD-2026-7KQ2MN',
    transactionAmount: 1,
    transactionStatus: { code: 200, status_message: 'Successful' },
    transactionStatusMessage: 'Approved',
    createdAt: '2026-10-24T10:00:00.000Z',
  };

  it('maps code 200 to payout.succeeded', () => {
    expect(normaliseKrediEvent(base)).toMatchObject({
      kind: 'payout.succeeded',
      eventId: 'payout:WD-2026-7KQ2MN:200',
      reference: 'WD-2026-7KQ2MN',
      providerPayoutId: 'KRDM_99980491533b',
    });
  });

  it('maps code 401 to payout.failed with the reason', () => {
    expect(
      normaliseKrediEvent({ ...base, transactionStatus: { code: 401, status_message: 'Failed' }, transactionStatusMessage: 'Beneficiary bank unavailable' }),
    ).toMatchObject({ kind: 'payout.failed', eventId: 'payout:WD-2026-7KQ2MN:401', reason: 'Beneficiary bank unavailable' });
  });

  it('treats processing (100) and incomplete (400) as not final', () => {
    expect(normaliseKrediEvent({ ...base, transactionStatus: { code: 100 } }).kind).toBe('ignored');
    expect(normaliseKrediEvent({ ...base, transactionStatus: { code: 400 } }).kind).toBe('ignored');
  });

  it('reads the async-transfer shape (yourReference, status.code)', () => {
    expect(normaliseKrediEvent({ krediReference: 'KRDM_1', yourReference: 'WD-2026-AAAAAA', transactionAmount: 5, status: { code: 200 } })).toMatchObject({
      kind: 'payout.succeeded',
      reference: 'WD-2026-AAAAAA',
    });
  });

  it('refuses a payout without our reference', () => {
    expect(() => normaliseKrediEvent({ krediReference: 'KRDM_1', transactionAmount: 5, transactionStatus: { code: 200 } })).toThrow(MalformedEventError);
  });
});

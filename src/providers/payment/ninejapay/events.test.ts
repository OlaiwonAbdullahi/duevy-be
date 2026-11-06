import { describe, expect, it } from 'vitest';
import { MalformedEventError, normaliseNineJaPayEvent } from './events';

// Shaped on docs.9japay.com/docs/web-hooks (with the docs' missing commas fixed).
const credit = (accountRequestReference: string, transactionType = 'Credit') => ({
  eventType: 'new_transaction',
  data: {
    id: '3f0c8b7e-0d3a-4c7e-9f59-1f1d1f3a2b10',
    transactionReference: 'IEKPGABMVNVGSMJFZBSAYW',
    accountNumber: '9000001277',
    accountName: 'Duevy',
    accountRequestReference,
    amount: 507500,
    balance: 507500,
    senderName: 'ADA OBI',
    senderAccountNumber: '0123456789',
    narration: 'dues',
    transactionType,
    transactionDate: '2026-11-06T10:00:00.000',
  },
});

describe('normaliseNineJaPayEvent', () => {
  it('maps a credit on a checkout account to payment.received, keyed by the account’s request reference', () => {
    const e = normaliseNineJaPayEvent(credit('DVY7KQ2MN4X'));
    expect(e).toMatchObject({ kind: 'payment.received', providerCheckoutId: 'DVY7KQ2MN4X', rawType: 'new_transaction' });
    expect(e.eventId).toBe('new_transaction:3f0c8b7e-0d3a-4c7e-9f59-1f1d1f3a2b10');
  });

  it('maps a credit on a space account to account.credited', () => {
    expect(normaliseNineJaPayEvent(credit('SPACEclx123abc'))).toMatchObject({ kind: 'account.credited', accountNumber: '9000001277' });
  });

  it('ignores debits and bill events', () => {
    expect(normaliseNineJaPayEvent(credit('DVY7KQ2MN4X', 'Debit')).kind).toBe('ignored');
    expect(normaliseNineJaPayEvent({ eventId: 'e1', eventType: 'bill_transaction', data: {} }).kind).toBe('ignored');
  });

  it('maps transfer_response to transfer.updated, keyed by our payment reference', () => {
    const e = normaliseNineJaPayEvent({
      eventId: 'ca5c3963-1111-2222-3333-444455556666',
      eventType: 'transfer_response',
      data: { requestReference: 'WD2026ABCDEF', sessionId: '999999240226070016257381097481', status: 'Success' },
    });
    expect(e).toMatchObject({ kind: 'transfer.updated', providerReference: 'WD2026ABCDEF', eventId: 'ca5c3963-1111-2222-3333-444455556666' });
  });

  it('refuses events it cannot identify', () => {
    expect(() => normaliseNineJaPayEvent({ data: {} })).toThrow(MalformedEventError);
    expect(() => normaliseNineJaPayEvent({ eventType: 'new_transaction', data: { transactionType: 'Credit' } })).toThrow(MalformedEventError);
    expect(() => normaliseNineJaPayEvent({ eventId: 'x', eventType: 'transfer_response', data: {} })).toThrow(MalformedEventError);
  });
});

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

  // The docs' own samples, verbatim apart from the missing comma they ship with.
  const DOCS_NEW_TRANSACTION = `{  "eventId": "7cb4dc1b-dace-4e1a-95a7-e27cc34c54bf",  "eventType": "new_transaction",  "data": {    "id": "f97996a9-3241-476d-a4e1-2422ac436d4a",    "transactionReference": "100004240220210739126986960617",    "accountNumber": "9000002140",    "accountName": "TOBI ADELAJA 29",    "accountRequestReference": "00000001",    "amount": 101000,    "balance": 9798000,    "senderName": "Michael Onyirimba",    "senderAccountNumber": "2000011041",    "senderBank": "9jaPay",    "senderBankCode": "090629",    "narration": "TRF: Michael Onyirimba|test transfer",    "transactionType": "Credit",    "transactionDate": "2024-02-20T21:07:39.775Z"  }}`;
  const DOCS_TRANSFER_RESPONSE = `{  "eventId": "ca5c3963-0b4d-4964-a207-94c82dff419c",  "eventType": "transfer_response",  "data": {    "requestReference": "00000007",    "sessionId": "999999240226070016257381097481",    "status": "Success"  }}`;

  it('reads the docs’ new_transaction sample: its eventId is the dedupe key, its UTC date is kept', () => {
    const e = normaliseNineJaPayEvent(JSON.parse(DOCS_NEW_TRANSACTION));
    expect(e).toMatchObject({ kind: 'payment.received', providerCheckoutId: '00000001', accountNumber: '9000002140', eventId: '7cb4dc1b-dace-4e1a-95a7-e27cc34c54bf' });
    expect(e.occurredAt.toISOString()).toBe('2024-02-20T21:07:39.775Z');
  });

  it('reads the docs’ transfer_response sample', () => {
    expect(normaliseNineJaPayEvent(JSON.parse(DOCS_TRANSFER_RESPONSE))).toMatchObject({
      kind: 'transfer.updated', providerReference: '00000007', eventId: 'ca5c3963-0b4d-4964-a207-94c82dff419c',
    });
  });

  it('ignores movements on Duevy’s own business account', () => {
    const body = JSON.parse(DOCS_NEW_TRANSACTION);
    expect(normaliseNineJaPayEvent(body, { businessAccountNumber: '9000002140' }).kind).toBe('ignored');
    expect(normaliseNineJaPayEvent(body, { businessAccountNumber: '1111111111' }).kind).toBe('payment.received');
  });
});

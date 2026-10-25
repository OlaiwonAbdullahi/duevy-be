import { describe, expect, it } from 'vitest';
import { MalformedEventError } from '../types';
import { normaliseBank78Event } from './events';
import { computeTransactionHash } from './signature';

const credit = {
  eventType: 'virtual-nuban-transaction-credit',
  data: {
    accountName: 'Duevy Ada Obi',
    accountNumber: '7001646987',
    accountReference: 'DVY-7KQ2-MN4X',
    amount: 5075.0,
    paymentDate: '2026-08-19T14:15:16',
    sessionId: '100033250929214652292538442532',
    notificationType: 'credit',
    status: 'transaction.success',
  },
};

describe('normaliseBank78Event', () => {
  it('maps a virtual account credit to payment.succeeded on our reference', () => {
    const e = normaliseBank78Event(credit);
    expect(e).toMatchObject({
      kind: 'payment.succeeded',
      eventId: 'virtual-nuban-transaction-credit:100033250929214652292538442532',
      reference: 'DVY-7KQ2-MN4X',
      providerChargeId: '100033250929214652292538442532',
      receivedKobo: 507_500,
      overpaidKobo: 0,
    });
    expect(e.occurredAt.toISOString()).toBe('2026-08-19T14:15:16.000Z');
  });

  it('still accepts a credit whose transactionHash does not match (the signature authenticates it)', () => {
    const good = computeTransactionHash('cs', credit.data.sessionId, 5075, credit.data.paymentDate);
    expect(normaliseBank78Event({ ...credit, data: { ...credit.data, transactionHash: good } }, { clientSecret: 'cs' }).kind).toBe('payment.succeeded');
    expect(normaliseBank78Event({ ...credit, data: { ...credit.data, transactionHash: 'ab'.repeat(64) } }, { clientSecret: 'cs' }).kind).toBe('payment.succeeded');
  });

  it('maps transfer.success to payout.succeeded with Bank78’s fee', () => {
    const e = normaliseBank78Event({
      eventType: 'transfer.success',
      data: { reference: 'WD-2026-ABC123', sessionId: 'S9', amount: 5000, fee: 25, status: 'success', responseCode: '00' },
    });
    expect(e).toMatchObject({ kind: 'payout.succeeded', eventId: 'transfer.success:S9', reference: 'WD-2026-ABC123', providerFeeKobo: 2_500 });
  });

  it('ignores events Duevy does not act on', () => {
    for (const eventType of [
      'virtual-nuban-transaction-acknowledgement',
      'virtual-nuban-transaction.failed',
      'sub-account-credit-success',
      'virtual-nuban-refund.success',
      'funding.success',
    ]) {
      expect(normaliseBank78Event({ eventType, data: { sessionId: 'S1', amount: 1 } }).kind).toBe('ignored');
    }
  });

  it('keys refunds on refundReference, so each attempt is its own event', () => {
    const e = normaliseBank78Event({ eventType: 'virtual-nuban-refund.failed', data: { sessionId: 'S1', refundReference: 'RFND-S1-2' } });
    expect(e.eventId).toBe('virtual-nuban-refund.failed:RFND-S1-2');
  });

  it('rejects a v1 body (no envelope) and events with no stable reference', () => {
    expect(() => normaliseBank78Event(credit.data)).toThrow(MalformedEventError);
    expect(() => normaliseBank78Event({ eventType: 'transfer.success', data: {} })).toThrow(MalformedEventError);
    expect(() => normaliseBank78Event({ ...credit, data: { ...credit.data, amount: 'lots' } })).toThrow(MalformedEventError);
  });
});

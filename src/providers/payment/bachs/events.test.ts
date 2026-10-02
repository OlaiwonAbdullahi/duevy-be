import { describe, expect, it } from 'vitest';
import { MalformedEventError, normaliseBachsEvent } from './events';

/** Fixtures follow the example payloads on docs.bachs.io/guides/webhooks/events/*. */
const envelope = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: `evt_${type.replace('.', '_')}`,
  type,
  created_at: '2026-09-22T10:41:18.402Z',
  organization_id: 'acct_platform',
  data,
  ...extra,
});

describe('normaliseBachsEvent', () => {
  it('maps collection.succeeded (SUCCEEDED) to payment.succeeded in kobo', () => {
    const e = normaliseBachsEvent(
      envelope('collection.succeeded', { reference: 'DVY-AAAA-BBBB', checkout_id: 'chk_1', charge_id: 'ch_1', status: 'SUCCEEDED', amount: '5120.00' }),
    );
    expect(e).toMatchObject({ kind: 'payment.succeeded', reference: 'DVY-AAAA-BBBB', providerCheckoutId: 'chk_1', receivedKobo: 512_000, overpaidKobo: 0 });
    expect(e.occurredAt.toISOString()).toBe('2026-09-22T10:41:18.402Z');
  });

  it('reads the received and overpaid amounts on OVERPAID', () => {
    const e = normaliseBachsEvent(
      envelope('collection.succeeded', {
        reference: 'R',
        status: 'OVERPAID',
        amount: '5120.00',
        expected_amount: '5120.00',
        received_amount: '6000.00',
        overpaid_amount: '880.00',
      }),
    );
    expect(e).toMatchObject({ kind: 'payment.succeeded', receivedKobo: 600_000, overpaidKobo: 88_000 });
  });

  it('maps collection.underpaid with paid and expected amounts', () => {
    const e = normaliseBachsEvent(
      envelope('collection.underpaid', { reference: 'R', amount_paid: '50000.00', amount_expected: '75000.00', status: 'UNDERPAID' }),
    );
    expect(e).toMatchObject({ kind: 'payment.underpaid', receivedKobo: 5_000_000, expectedKobo: 7_500_000 });
  });

  it('maps collection.failed EXPIRED to expired and FAILED to failed', () => {
    expect(normaliseBachsEvent(envelope('collection.failed', { reference: 'R', status: 'EXPIRED' })).kind).toBe('payment.expired');
    expect(normaliseBachsEvent(envelope('collection.failed', { reference: 'R', status: 'FAILED', reason: 'x' }))).toMatchObject({
      kind: 'payment.failed',
      reason: 'x',
    });
  });

  it('maps checkout.expired, and ignores checkout.completed', () => {
    expect(normaliseBachsEvent(envelope('checkout.expired', { checkout_id: 'chk_1', reference: 'R' })).kind).toBe('payment.expired');
    expect(normaliseBachsEvent(envelope('checkout.completed', { checkout_id: 'chk_1', payment_status: 'paid' })).kind).toBe('ignored');
  });

  it('maps payout events by our reference', () => {
    expect(
      normaliseBachsEvent(envelope('payout.paid', { withdrawal_id: 'pay_1', reference: 'WD-2026-AAAAAA', status: 'completed', withdrawal_fee: '100.00' })),
    ).toMatchObject({ kind: 'payout.succeeded', reference: 'WD-2026-AAAAAA', providerPayoutId: 'pay_1', providerFeeKobo: 10_000 });
    expect(normaliseBachsEvent(envelope('payout.failed', { withdrawal_id: 'pay_1', reference: 'WD', status: 'failed' }))).toMatchObject({
      kind: 'payout.failed',
      reference: 'WD',
    });
  });

  it('maps account.updated / capability.updated to identity.updated for the connected account', () => {
    const e = normaliseBachsEvent(
      envelope('capability.updated', { account: 'acct_rep', capability: 'payouts', status: 'active' }, { account: 'acct_rep', organization_id: 'acct_rep' }),
    );
    expect(e).toMatchObject({ kind: 'identity.updated', accountId: 'acct_rep' });
  });

  it('ignores a non-final collection.succeeded status and unknown event types', () => {
    expect(normaliseBachsEvent(envelope('collection.succeeded', { status: 'PENDING', amount: '1.00' })).kind).toBe('ignored');
    expect(normaliseBachsEvent(envelope('invoice.paid', {})).kind).toBe('ignored');
  });

  it('throws MalformedEventError rather than guessing at a broken payment event', () => {
    expect(() => normaliseBachsEvent({ type: 'collection.succeeded' })).toThrow(MalformedEventError);
    expect(() => normaliseBachsEvent(envelope('collection.succeeded', { status: 'SUCCEEDED' }))).toThrow(MalformedEventError);
    expect(() => normaliseBachsEvent(envelope('collection.underpaid', { amount_paid: 'lots' }))).toThrow(MalformedEventError);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { InterswitchProvider } from './InterswitchProvider';
import { normaliseInterswitchEvent } from './events';
import { verifyInterswitchSignature } from './signature';
import { type InterswitchConfig } from './client';

const cfg: InterswitchConfig = {
  env: 'test',
  clientId: 'id',
  clientSecret: 'secret',
  merchantCode: 'MX6072',
  payItemId: '9405967',
  currency: '566',
  passportUrl: 'https://sandbox.interswitchng.com/passport/oauth/token',
  collectionsUrl: 'https://sandbox.interswitchng.com',
  payoutsUrl: 'https://payouts-sandbox.interswitchng.com/api/v1/payouts',
  vaUrl: 'https://sandbox.interswitchng.com',
  inlineCheckoutUrl: 'https://newwebpay.qa.interswitchng.com/inline-checkout.js',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('createGatewayCheckout', () => {
  it('builds IPG inline params with txn_ref stripped and amount in kobo', () => {
    const p = new InterswitchProvider(cfg);
    const params = p.createGatewayCheckout({ reference: 'DVY-7KQ2-MN4X', totalKobo: 203000, redirectUrl: 'https://api.duevy.app/v1/public/pay/callback?ref=DVY-7KQ2-MN4X' });
    expect(params).toMatchObject({
      provider: 'interswitch',
      merchantCode: 'MX6072',
      payItemId: '9405967',
      txnRef: 'DVY7KQ2MN4X', // hyphens stripped
      amountKobo: 203000,
      currency: '566',
      mode: 'TEST',
    });
    expect(params.scriptUrl).toContain('inline-checkout.js');
  });
});

describe('verifyGatewayCheckout (gettransaction.json)', () => {
  it('accepts only ResponseCode 00 with a matching amount', async () => {
    const p = new InterswitchProvider(cfg);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ResponseCode: '00', Amount: 203000, PaymentReference: 'FBN|WEB|MX6072|123', MerchantReference: 'DVY7KQ2MN4X' }),
    );
    const status = await p.verifyGatewayCheckout('DVY-7KQ2-MN4X', 203000);
    expect(status.state).toBe('paid');
    expect(status.receivedKobo).toBe(203000);
    expect(status.transactionId).toBe('FBN|WEB|MX6072|123');
  });

  it('does not accept an approved payment whose amount differs', async () => {
    const p = new InterswitchProvider(cfg);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ResponseCode: '00', Amount: 100000 }));
    const status = await p.verifyGatewayCheckout('DVY-7KQ2-MN4X', 203000);
    expect(status.state).toBe('open');
    expect(status.transactionId).toBeNull();
  });

  it('treats a declined / pending / unknown transaction as open (unpaid)', async () => {
    const p = new InterswitchProvider(cfg);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ResponseCode: 'Z6', PlainTextXMLResponse: '', Amount: 0 }));
    const status = await p.verifyGatewayCheckout('DVY-7KQ2-MN4X', 203000);
    expect(status.state).toBe('open');
  });
});

describe('normaliseInterswitchEvent', () => {
  it('maps a transaction naming our merchant reference to payment.received', () => {
    const ev = normaliseInterswitchEvent({
      eventType: 'TRANSACTION.COMPLETED',
      data: { merchantReference: 'DVY7KQ2MN4X', paymentReference: 'FBN|WEB|1', amount: 203000, transactionDate: '2026-11-14T10:00:00Z' },
    });
    expect(ev.kind).toBe('payment.received');
    if (ev.kind === 'payment.received') expect(ev.providerCheckoutId).toBe('DVY7KQ2MN4X');
  });

  it('maps a payout event to transfer.updated', () => {
    const ev = normaliseInterswitchEvent({ eventType: 'PAYOUT.COMPLETED', data: { transactionReference: 'WD2026ABC', status: 'completed' } });
    expect(ev.kind).toBe('transfer.updated');
    if (ev.kind === 'transfer.updated') expect(ev.providerReference).toBe('WD2026ABC');
  });

  it('maps a bare virtual-account credit to account.credited', () => {
    const ev = normaliseInterswitchEvent({ eventType: 'TRANSACTION.COMPLETED', data: { virtualAccountNumber: '1234567890', amount: 500000, id: 'tx1' } });
    expect(ev.kind).toBe('account.credited');
    if (ev.kind === 'account.credited') expect(ev.accountNumber).toBe('1234567890');
  });
});

describe('verifyInterswitchSignature', () => {
  const body = Buffer.from('{"eventType":"TRANSACTION.COMPLETED"}');

  it('accepts an unsigned event in test when no secret is configured', () => {
    expect(verifyInterswitchSignature(body, {}, undefined, 'test').ok).toBe(true);
  });

  it('rejects a missing secret in live', () => {
    expect(verifyInterswitchSignature(body, {}, undefined, 'live').ok).toBe(false);
  });

  it('accepts a correct HMAC and rejects a wrong one', () => {
    const { createHmac } = require('crypto') as typeof import('crypto');
    const good = createHmac('sha256', 's3cret').update(body).digest('base64');
    expect(verifyInterswitchSignature(body, { 'x-interswitch-signature': good }, 's3cret', 'live').ok).toBe(true);
    expect(verifyInterswitchSignature(body, { 'x-interswitch-signature': 'nope' }, 's3cret', 'live').ok).toBe(false);
  });
});

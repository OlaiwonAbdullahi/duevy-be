import { afterEach, describe, expect, it, vi } from 'vitest';
import { KrediProvider, localPhone, sameAccountHolder } from './KrediProvider';
import { ProviderError } from '../types';

type Route = (url: URL, init: RequestInit) => { status?: number; body: unknown };

/** Stub fetch with handlers keyed by "METHOD /path"; records every call. */
function stubKredi(routes: Record<string, Route>) {
  const calls: { key: string; url: URL; body: unknown; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: 'not stubbed' }), { status: 404 });
    const { status = 200, body } = route(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

const provider = () =>
  new KrediProvider({
    baseUrl: 'https://walletv2-api.test.kredimfb.com',
    collectionBaseUrl: 'https://collection-api.test.kredimfb.com',
    apiKey: 'api_key',
    authToken: 'token',
    webhookSecrets: ['s'],
    collectionWebhookUrl: 'https://api.duevy.test/v1/webhooks/kredi',
  });

const enquiry = (accountName = 'ADA OBI'): Route => () => ({
  body: { status: 'Success', data: { accountNumber: '0123456789', accountName, kycLevel: '3', bvn: '22222222222', responseCode: '00' } },
});
const destination = { bankCode: '000013', accountNumber: '0123456789', accountName: 'ADA OBI' };

afterEach(() => vi.unstubAllGlobals());

describe('KrediProvider — collections', () => {
  // The response below is what the Kredi test environment returned for generate_account.
  const generated = (amount: string) => () => ({
    body: {
      status: 200,
      message: 'Payment account generated successfully',
      data: {
        id: '17929193636addc743d70c9',
        transaction_ref: null,
        amount,
        name: 'Duevy Labs Ltd',
        account: { id: 138, nuban: '0827533187', created_at: '2026-10-25T09:09:23.000000Z', expired_at: '2026-10-27 10:09:23' },
        status: 0,
        expiry: { expired_in: 48, unit: 'hours', expired_at: 'Tue, 27 October 2026 10:09:23' },
      },
    },
  });

  it('opens a temporary account for face + fee on the collection host', async () => {
    const calls = stubKredi({ 'POST /api/generate_account': generated('5095.00') });
    const account = await provider().createCollectionAccount({
      reference: 'DVY-AAAA-BBBB',
      faceKobo: 500_000,
      platformFeeKobo: 9_500,
      customer: { email: 'a@b.c', name: 'Ada Obi', phone: '+2348012345678' },
      expiresInMinutes: 60,
      metadata: {},
      returnUrl: 'https://duevy.test/pay',
    });
    expect(account).toEqual({
      providerCheckoutId: '17929193636addc743d70c9',
      providerChargeId: null,
      accountNumber: '0827533187',
      bankName: null,
      accountName: 'Duevy Labs Ltd',
      checkoutUrl: null,
      totalKobo: 509_500,
      // created_at (UTC) + 48 hours
      expiresAt: new Date('2026-10-27T09:09:23.000Z'),
    });
    expect(calls[0]!.url.host).toBe('collection-api.test.kredimfb.com');
    expect(calls[0]!.body).toMatchObject({
      transaction_ref: 'DVY-AAAA-BBBB',
      amount: '5095.00',
      currency: 'NGN',
      webhook_url: 'https://api.duevy.test/v1/webhooks/kredi',
      customer: { first_name: 'Ada', last_name: 'Obi', phone_number: '08012345678' },
    });
    expect(calls[0]!.headers).toMatchObject({ 'x-api-key': 'api_key', Authorization: 'Bearer token' });
  });

  it('reads a 30-minute production expiry', async () => {
    stubKredi({
      'POST /api/generate_account': () => ({
        body: {
          status: 200,
          data: { id: 'x1', amount: '5095.00', name: 'Duevy Labs Ltd', account: { nuban: '0827533187', created_at: '2026-10-25T09:00:00.000000Z' }, expiry: { expired_in: 30, unit: 'minutes' } },
        },
      }),
    });
    const account = await provider().createCollectionAccount({
      reference: 'DVY-AAAA-DDDD', faceKobo: 500_000, platformFeeKobo: 9_500,
      customer: { email: 'a@b.c', name: 'Ada Obi' }, expiresInMinutes: 30, metadata: {}, returnUrl: 'https://duevy.test/pay',
    });
    expect(account.expiresAt).toEqual(new Date('2026-10-25T09:30:00.000Z'));
  });

  it('refuses an account priced differently from the checkout', async () => {
    stubKredi({ 'POST /api/generate_account': generated('10.00') });
    await expect(
      provider().createCollectionAccount({
        reference: 'DVY-AAAA-CCCC',
        faceKobo: 500_000,
        platformFeeKobo: 9_500,
        customer: { email: 'a@b.c', name: 'Ada Obi' },
        expiresInMinutes: 60,
        metadata: {},
        returnUrl: 'https://duevy.test/pay',
      }),
    ).rejects.toMatchObject({ code: 'PRICE_MISMATCH', retryable: false });
  });

  it('makes no status call it has no documented endpoint for', async () => {
    const calls = stubKredi({});
    expect(await provider().getCollectionStatus('17929193636addc743d70c9')).toEqual({ state: 'open', receivedKobo: null });
    expect(calls).toHaveLength(0);
  });
});

describe('KrediProvider — V2 payouts', () => {
  it('re-runs name enquiry and sends a V2 fundtransfer with the holder BVN', async () => {
    const calls = stubKredi({
      'GET /api/kredipay/nameenquiry': enquiry(),
      'POST /api/kredipay/fundtransfer': () => ({
        body: { message: 'Transaction Approved', status: 'Success', data: { responseCode: '00', cbaTransactionId: 'TBMFB_1' } },
      }),
    });
    const r = await provider().initiatePayout({ destination, amountKobo: 1_988_000, reference: 'WD-2026-AAAAAA' });
    expect(r).toMatchObject({ state: 'succeeded', providerPayoutId: 'TBMFB_1', providerFeeKobo: 7_500 });
    const transfer = calls.find((c) => c.key === 'POST /api/kredipay/fundtransfer')!;
    expect(transfer.body).toMatchObject({
      transaction_reference: 'WD-2026-AAAAAA',
      transaction_amount: 19880,
      beneficiary_account_no: '0123456789',
      beneficiary_entity_code: '000013',
      beneficiary_bvn: '22222222222',
      beneficiary_kyc_level: '3',
    });
  });

  it('refuses to pay an account whose holder has changed', async () => {
    const calls = stubKredi({ 'GET /api/kredipay/nameenquiry': enquiry('SOMEONE ELSE') });
    await expect(provider().initiatePayout({ destination, amountKobo: 100_000, reference: 'WD-2026-BBBBBB' })).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
      retryable: false,
    });
    expect(calls.some((c) => c.key === 'POST /api/kredipay/fundtransfer')).toBe(false);
  });

  it('resolves a duplicate reference through TSQ instead of paying again', async () => {
    const calls = stubKredi({
      'GET /api/kredipay/nameenquiry': enquiry(),
      'POST /api/kredipay/fundtransfer': () => ({
        status: 400,
        body: { message: 'Duplicate transaction reference (WD-2026-CCCCCC)', status: 'Failed' },
      }),
      'GET /api/kredipay/transactions/WD-2026-CCCCCC': () => ({ body: { status: 'Success', data: { responseCode: '00', cbaTransactionId: 'TBMFB_2' } } }),
    });
    const r = await provider().initiatePayout({ destination, amountKobo: 100_000, reference: 'WD-2026-CCCCCC' });
    expect(r).toMatchObject({ state: 'succeeded', providerPayoutId: 'TBMFB_2' });
    expect(calls.filter((c) => c.key === 'POST /api/kredipay/fundtransfer')).toHaveLength(1);
  });

  it('a timeout is retryable — never read as "did not happen"', async () => {
    stubKredi({ 'GET /api/kredipay/nameenquiry': enquiry() });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      if (String(input).includes('fundtransfer')) throw new Error('The operation was aborted due to timeout');
      return real(input, init);
    });
    const err = await provider().initiatePayout({ destination, amountKobo: 100_000, reference: 'WD-2026-DDDDDD' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });
});

describe('KrediProvider — payout status', () => {
  it('reports success from TSQ', async () => {
    stubKredi({ 'GET /api/kredipay/transactions/WD-1': () => ({ body: { status: 'Success', data: { responseCode: '00' } } }) });
    expect((await provider().getPayout('WD-1')).state).toBe('succeeded');
  });

  it('reads a failure only from Kredi’s own final 401', async () => {
    stubKredi({
      'GET /api/kredipay/transactions/WD-2': () => ({ status: 400, body: { message: 'Transaction with reference: (WD-2) does not exist.', status: 'Failed' } }),
      'GET /api/v2/transactions/search': () => ({
        body: { status: 200, data: { data: [{ yourReference: 'WD-2', krediReference: 'KRDM_9', status: { code: 401, status_message: 'Failed' } }] } },
      }),
    });
    expect(await provider().getPayout('WD-2')).toMatchObject({ state: 'failed', providerPayoutId: 'KRDM_9' });
  });

  it('stays processing when Kredi has no final answer', async () => {
    stubKredi({
      'GET /api/kredipay/transactions/WD-3': () => ({ body: { status: 'Success', data: { responseCode: '09' } } }),
      'GET /api/v2/transactions/search': () => ({ body: { data: { data: [{ yourReference: 'WD-3', status: { code: 100 } }] } } }),
    });
    expect((await provider().getPayout('WD-3')).state).toBe('processing');
  });
});

describe('KrediProvider — reps and banks', () => {
  it('registers the rep as a customer with the local phone format', async () => {
    const calls = stubKredi({ 'POST /api/wallet/customers/create': () => ({ body: { status: 200, data: { id: 'cus_1', nuban: '1679048024' } } }) });
    const r = await provider().verifyIdentity({
      profile: { userId: 'u1', email: 'a@b.c', firstName: 'Ada', lastName: 'Obi', displayName: 'Ada Obi', phone: '+2348101234520' },
      idNumbers: [{ type: 'bvn', value: '12345678901' }],
      gender: 'female',
      address: '4 Jakande Estate, Lagos',
    });
    expect(r).toMatchObject({ accountId: 'cus_1', accountNumber: '1679048024', status: 'verified' });
    expect(calls[0]!.body).toMatchObject({ phone: '08101234520', country: 'Nigeria', gender: 'female', bvn: '12345678901' });
  });

  it('uses the NIP code as the bank code', async () => {
    stubKredi({
      'GET /api/kredipay/banks': () => ({ body: { status: 200, data: [{ institutionCode: '044', nipCode: '000014', institutionName: 'Access Bank' }] } }),
    });
    expect(await provider().listBanks()).toEqual([{ code: '000014', name: 'Access Bank' }]);
  });

  it('treats a refused name enquiry as an unknown account', async () => {
    stubKredi({ 'GET /api/kredipay/nameenquiry': () => ({ status: 400, body: { status: 'Failed', message: 'Invalid account' } }) });
    expect(await provider().resolveAccount('000014', '0000000000')).toBeNull();
  });

  it('reads the merchant balance in kobo', async () => {
    stubKredi({ 'GET /api/wallet/account/balance': () => ({ body: { status: 200, data: { availableBalance: 5012.34, accountBalance: 5012.34 } } }) });
    expect(await provider().getPlatformBalance()).toEqual({ availableKobo: 501_234 });
  });
});

describe('helpers', () => {
  it('formats phones as Kredi expects', () => {
    expect(localPhone('+2348101234520')).toBe('08101234520');
    expect(localPhone(null)).toBe('');
  });

  it('matches account holders regardless of order and punctuation', () => {
    expect(sameAccountHolder('OBI, ADA C.', 'Ada Obi C')).toBe(true);
    expect(sameAccountHolder('ADA OBI', 'ADA OKAFOR')).toBe(false);
  });
});

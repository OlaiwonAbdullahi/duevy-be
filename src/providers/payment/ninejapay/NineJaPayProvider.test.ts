import { afterEach, describe, expect, it, vi } from 'vitest';
import { NineJaPayProvider } from './NineJaPayProvider';
import { ProviderError } from '../types';

const provider = new NineJaPayProvider(
  {
    baseUrl: 'https://developer.test.9japay.com',
    apiKey: '00000000-0000-0000-0000-000000000000',
    secretKey: 'sk_test',
    businessAccountNumber: '3000000000',
    bankCode: '090629',
  },
  ['sk_test'],
);

/** Responses recorded from the 9jaPay sandbox on 2026-11-06. */
function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe('NineJaPayProvider against recorded sandbox responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('name enquiry: an unknown account is unverifiable, even though 9jaPay answers 500', async () => {
    respond(500, { status: 'FAILED', message: 'Unable to validate account number!', statusCode: '06' });
    expect(await provider.resolveAccount('058', '0123456789')).toBeNull();
  });

  it('name enquiry: a genuine outage is still an error', async () => {
    respond(503, { status: 'FAILED', message: 'Service Unavailable', statusCode: '06' });
    await expect(provider.resolveAccount('058', '0123456789')).rejects.toBeInstanceOf(ProviderError);
  });

  it('name enquiry: returns the bank name', async () => {
    respond(200, {
      status: 'SUCCESS',
      statusCode: '00',
      data: { accountName: 'Duevy Labs Ltd-test-account', accountNumber: '3000029402', bankCode: '090629', nameEnquiryReference: 'abc' },
    });
    expect(await provider.resolveAccount('090629', '3000029402')).toEqual({ accountName: 'Duevy Labs Ltd-test-account' });
  });

  it('TSQ: a reference never sent is NOT_FOUND (404, "25"), so it can be sent again', async () => {
    respond(404, { status: 'FAILED', message: 'No record found.', statusCode: '25' });
    await expect(provider.getTransfer('WD-2026-ABCDEF')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('TSQ: reads data.status, not the outer status', async () => {
    respond(200, { status: 'SUCCESS', statusCode: '00', data: { paymentReference: 'SWPPROBE', amount: 10000, status: 'Failed' } });
    expect(await provider.getTransfer('SWPPROBE')).toMatchObject({ state: 'failed', providerReference: 'SWPPROBE' });
  });

  it('a transfer refused for insufficient funds fails, not retried; the sender name comes from name enquiry', async () => {
    const names: Record<string, string> = { '3000000000': 'Duevy Labs Ltd-test-account', '9000143203': 'DUEVY/Probe Space' };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (String(url).endsWith('/name-enquiry')) {
        return new Response(
          JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { accountName: names[body.accountNumber], accountNumber: body.accountNumber, bankCode: '090629', nameEnquiryReference: `ne_${body.accountNumber}` } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ status: 'FAILED', statusCode: '09', message: 'You currently have insufficient funds. To complete this transaction, kindly fund your account and retry.' }),
        { status: 400 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      provider.initiateTransfer({ from: 'business', bankCode: '090629', accountNumber: '9000143203', accountName: 'x', amountKobo: 10000, reference: 'SWP2026TEST', narration: 'sweep' }),
    ).rejects.toMatchObject({ retryable: false });
    const transfer = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/api/transfers'))!;
    expect(JSON.parse(transfer[1]!.body as string)).toMatchObject({
      paymentReference: 'SWP2026TEST',
      senderAccountNumber: '3000000000',
      senderAccountName: 'Duevy Labs Ltd-test-account',
      recipientAccountName: 'DUEVY/Probe Space',
      amount: '10000',
      nameEnquiryReference: 'ne_9000143203',
    });

    // Looked up once per process, not on every transfer.
    fetchMock.mockClear();
    await provider.initiateTransfer({ from: 'business', bankCode: '090629', accountNumber: '9000143203', accountName: 'x', amountKobo: 10000, reference: 'SWP2026TES2', narration: 'sweep' }).catch(() => {});
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/name-enquiry') && (init!.body as string).includes('3000000000'))).toHaveLength(0);
  });

  it('a one-time account is ready after ONE call; the expiry counts from 9jaPay’s answer', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { requestReference: 'DVYPROBE', id: 'id1', accountNumber: '9000143193' } }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now();
    const account = await provider.createCollectionAccount({ reference: 'DVY-PROB-E000', totalKobo: 507500, expiresInMinutes: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(account).toMatchObject({ providerCheckoutId: 'DVYPROBE000', accountNumber: '9000143193', accountName: 'DUEVY COLLECTION ACCOUNT', bankName: '9jaPay' });
    // Never before 9jaPay's own expiry, so no real payment falls outside the window.
    expect(account.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      requestReference: 'DVYPROBE000',
      amount: 507500,
      timeToLive: '1800',
      IsSinglePayment: true,
    });
  });

  it('describes a one-time account with the name and exact expiry 9jaPay holds', async () => {
    respond(200, {
      status: 'SUCCESS',
      statusCode: '00',
      data: { accountNumber: '9000143193', accountName: 'DUEVY COLLECTION ACCOUNT', expiresAt: '2026-11-06T18:50:32.618536Z', status: 'Active' },
    });
    const found = await provider.describeCollectionAccount('9000143193');
    expect(found?.accountName).toBe('DUEVY COLLECTION ACCOUNT');
    expect(found?.expiresAt?.toISOString()).toBe('2026-11-06T18:50:32.618Z');
  });
});

describe('one-time account numbers are reused', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Recorded 2026-11-07: account 9000143193 had served a checkout the day
  // before. Its list shows the new credit and the closure debit (Lagos times).
  const listing = (credits: { date: string; amount: number }[]) => ({
    status: 'SUCCESS',
    statusCode: '00',
    data: [
      { transactionId: 'd1', accountNumber: '9000143193', transactionType: 'Debit', amount: 507500, narration: 'VIRTUAL ACCOUNT CLOSURE TRANSFER', transactionDate: '2026-11-07T08:35:41.471726' },
      ...credits.map((c, i) => ({ transactionId: `c${i}`, accountNumber: '9000143193', transactionType: 'Credit', amount: c.amount, transactionDate: c.date })),
    ],
  });

  it('reads 9jaPay’s offset-less dates as Lagos time', async () => {
    const { parseNineJaPayDate } = await import('./NineJaPayProvider');
    expect(parseNineJaPayDate('2026-11-07T08:35:38.005074')?.toISOString()).toBe('2026-11-07T07:35:38.005Z');
    expect(parseNineJaPayDate('2026-11-07T08:05:36.059909Z')?.toISOString()).toBe('2026-11-07T08:05:36.059Z');
    expect(parseNineJaPayDate(undefined)).toBeNull();
  });

  it("counts only the credit inside this checkout's window, never another checkout's on the same number", async () => {
    respond(200, listing([
      { date: '2026-11-06T19:40:00.000000', amount: 999_900 }, // yesterday's checkout on this number
      { date: '2026-11-07T08:35:38.005074', amount: 507_500 }, // this one
    ]));
    const window = { from: new Date('2026-11-07T07:30:00Z'), to: new Date('2026-11-07T08:07:00Z') };
    expect(await provider.getCollectionStatus('9000143193', window)).toEqual({
      state: 'paid',
      receivedKobo: 507_500,
      credits: [{ transactionId: 'c1', amountKobo: 507_500, at: new Date('2026-11-07T07:35:38.005Z') }],
    });

    // An older checkout that once had this number sees nothing of today's money.
    const old = { from: new Date('2026-11-06T18:00:00Z'), to: new Date('2026-11-06T18:30:00Z') };
    expect(await provider.getCollectionStatus('9000143193', old)).toMatchObject({ state: 'open', receivedKobo: null });
  });

  it('reads past page 1: a much-reused number has more rows than one page', async () => {
    const row = (i: number, date: string, type = 'Debit') => ({ transactionId: `t${i}`, accountNumber: '9000143193', transactionType: type, amount: 100_000, transactionDate: date });
    const page1 = Array.from({ length: 50 }, (_, i) => row(i, '2026-10-01T10:00:00'));
    const page2 = [row(50, '2026-11-07T08:35:38', 'Credit')];
    const fetchMock = vi.fn(async (url: unknown) => {
      const page = new URL(String(url)).searchParams.get('page-number');
      return new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: page === '1' ? page1 : page2 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const window = { from: new Date('2026-11-07T07:30:00Z'), to: new Date('2026-11-07T08:07:00Z') };
    expect(await provider.getCollectionStatus('9000143193', window)).toMatchObject({ state: 'paid', receivedKobo: 100_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transfer status from the create response', () => {
  afterEach(() => vi.unstubAllGlobals());

  const transferWith = (transfer: unknown) =>
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (String(url).endsWith('/name-enquiry')) {
        return new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { accountName: 'X', accountNumber: body.accountNumber, bankCode: '058', nameEnquiryReference: 'ne' } }), { status: 200 });
      }
      return new Response(JSON.stringify(transfer), { status: 200 });
    });
  const send = (reference: string) =>
    provider.initiateTransfer({ from: { accountNumber: '9000143203', accountName: 'DUEVY/Space' }, bankCode: '058', accountNumber: '0123456789', accountName: 'x', amountKobo: 50_000, reference, narration: 'w' });

  it('an outer SUCCESS with data.status Processing is processing, not done', async () => {
    vi.stubGlobal('fetch', transferWith({ status: 'SUCCESS', statusCode: '01', data: { paymentReference: 'WD1', status: 'Processing' } }));
    expect(await send('WD-1')).toMatchObject({ state: 'processing' });
  });

  it('an outer SUCCESS with data.status Failed is failed', async () => {
    vi.stubGlobal('fetch', transferWith({ status: 'SUCCESS', statusCode: '00', data: { paymentReference: 'WD2', status: 'Failed' } }));
    expect(await send('WD-2')).toMatchObject({ state: 'failed' });
  });

  it('no data.status: only "00" counts as done', async () => {
    vi.stubGlobal('fetch', transferWith({ status: 'SUCCESS', statusCode: '01', data: { paymentReference: 'WD3' } }));
    expect(await send('WD-3')).toMatchObject({ state: 'processing' });
    vi.stubGlobal('fetch', transferWith({ status: 'SUCCESS', statusCode: '00', data: { paymentReference: 'WD4' } }));
    expect(await send('WD-4')).toMatchObject({ state: 'succeeded' });
  });

  it('TSQ: a reversed transfer is failed', async () => {
    respond(200, { status: 'SUCCESS', statusCode: '00', data: { paymentReference: 'WD5', status: 'Reversed' } });
    expect(await provider.getTransfer('WD-5')).toMatchObject({ state: 'failed' });
  });
});

describe('withdrawals from a space account', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the space account's name as the bank holds it, not the one stored with the space", async () => {
    const names: Record<string, string> = { '9000777001': 'DUEVY/Computer Science', '0123456789': 'ADA OBI' };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (String(url).endsWith('/name-enquiry')) {
        return new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { accountName: names[body.accountNumber], accountNumber: body.accountNumber, bankCode: body.bankCode, nameEnquiryReference: `ne_${body.accountNumber}` } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { id: 't1' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider.initiateTransfer({ from: { accountNumber: '9000777001', accountName: 'Computer Science' }, bankCode: '058', accountNumber: '0123456789', accountName: 'x', amountKobo: 50_000, reference: 'WD-NAME', narration: 'w' });
    expect(result.state).toBe('succeeded');
    const transfer = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/transfers/virtual-account'))!;
    expect(JSON.parse(transfer[1]!.body as string)).toMatchObject({ senderAccountName: 'DUEVY/Computer Science', recipientAccountName: 'ADA OBI' });
  });
});

describe('the transactions lookup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is bounded to the window's Lagos days, a day either side", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // 23:30 UTC is already the next day in Lagos.
    await provider.getCollectionStatus('9000143193', { from: new Date('2026-11-06T23:30:00Z'), to: new Date('2026-11-07T00:10:00Z') });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect([url.searchParams.get('start-date'), url.searchParams.get('end-date')]).toEqual(['2026-11-06', '2026-11-08']);
  });
});

describe('space accounts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a reference already used (an earlier attempt timed out) moves on to the next one instead of blocking the space', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (String(url).endsWith('/permanent')) {
        sent.push(body.requestReference);
        if (sent.length === 1) return new Response(JSON.stringify({ status: 'FAILED', statusCode: '26', message: 'Duplicate request reference' }), { status: 400 });
        return new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { id: 'va2', accountNumber: '9000999999' } }), { status: 201 });
      }
      return new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { accountName: 'DUEVY/Space', accountNumber: '9000999999', bankCode: '090629', nameEnquiryReference: 'ne' } }), { status: 200 });
    }));
    const account = await provider.createSpaceAccount({ reference: 'spc_123', accountName: 'Space' });
    expect(sent).toEqual(['SPACEspc123', 'SPACEspc123R1']);
    expect(account).toMatchObject({ accountNumber: '9000999999', accountName: 'DUEVY/Space' });
  });
});

describe('credits on a space account', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells our sweep from money sent straight to the account (recorded 2026-11-07)', async () => {
    respond(200, {
      status: 'SUCCESS',
      statusCode: '00',
      data: [
        {
          transactionId: '0a25b830-2127-45fa-81b5-b89824574765', accountNumber: '9000143519', transactionType: 'Credit', amount: 25000,
          narration: 'Virtual account test deposit', transactionDate: '2026-11-07T14:43:16.655952',
          metadata: { senderAccountName: 'Test Account', senderAccountNumber: '11906', senderBank: '9jaPay', senderBankCode: '090629' },
        },
        {
          transactionId: '2d22af13-5192-44b4-88d8-d912fad4dc8a', accountNumber: '9000143519', transactionType: 'Credit', amount: 10000,
          narration: 'Duevy collections probe FROM Duevy Labs Ltd-test-account TO DUEVY/Direct', transactionDate: '2026-11-07T14:43:15.237',
          metadata: { senderAccountName: 'Duevy Labs Ltd-test-account', senderAccountNumber: '3000000000', senderBank: '9jaPay', senderBankCode: '090629' },
        },
        { transactionId: 'r1', accountNumber: '9000143519', transactionType: 'Credit', amount: 5000, narration: 'REVERSAL: failed transfer', transactionDate: '2026-11-07T14:50:00.000' },
        { transactionId: 'w1', accountNumber: '9000143519', transactionType: 'Debit', amount: 5000, narration: 'withdrawal', transactionDate: '2026-11-07T14:45:00.000' },
      ],
    });
    const credits = await provider.listAccountCredits('9000143519', { from: new Date('2026-11-07T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z') });
    expect(credits.map((c) => [c.transactionId, c.source, c.amountKobo])).toEqual([
      ['2d22af13-5192-44b4-88d8-d912fad4dc8a', 'business', 10000],
      ['0a25b830-2127-45fa-81b5-b89824574765', 'external', 25000],
      ['r1', 'reversal', 5000],
    ]);
    expect(credits[1]).toMatchObject({ senderName: 'Test Account', senderAccountNumber: '11906', at: new Date('2026-11-07T13:43:16.655Z') });
  });
});

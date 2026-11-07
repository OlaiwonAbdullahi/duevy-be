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

  it('a one-time account takes the name and expiry 9jaPay gives it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'SUCCESS', statusCode: '00', data: { requestReference: 'DVYPROBE', id: 'id1', accountNumber: '9000143193' } }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'SUCCESS',
            statusCode: '00',
            data: { accountNumber: '9000143193', accountName: 'DUEVY COLLECTION ACCOUNT', expiresAt: '2026-11-06T18:50:32.618536Z', status: 'Active' },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const account = await provider.createCollectionAccount({ reference: 'DVY-PROB-E000', totalKobo: 507500, expiresInMinutes: 30 });
    expect(account).toMatchObject({ providerCheckoutId: 'DVYPROBE000', accountNumber: '9000143193', accountName: 'DUEVY COLLECTION ACCOUNT', bankName: '9jaPay' });
    expect(account.expiresAt.toISOString()).toBe('2026-11-06T18:50:32.618Z');
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      requestReference: 'DVYPROBE000',
      amount: 507500,
      timeToLive: '1800',
      IsSinglePayment: true,
    });
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
    expect(await provider.getCollectionStatus('9000143193', window)).toEqual({ state: 'paid', receivedKobo: 507_500 });

    // An older checkout that once had this number sees nothing of today's money.
    const old = { from: new Date('2026-11-06T18:00:00Z'), to: new Date('2026-11-06T18:30:00Z') };
    expect(await provider.getCollectionStatus('9000143193', old)).toEqual({ state: 'open', receivedKobo: null });
  });
});

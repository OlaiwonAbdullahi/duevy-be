import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { sendReceiptLookupEmail } from '../../lib/email';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp } from './fixtures';

vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendDuePaymentReceiptEmail: vi.fn(async () => {}),
  sendRepPaymentReceivedEmail: vi.fn(async () => {}),
  sendReceiptLookupEmail: vi.fn(async () => {}),
}));
const lookupEmail = vi.mocked(sendReceiptLookupEmail);

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

async function paidGuestReceipt(email: string) {
  const { dues } = await makeSpace();
  const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
  const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
    body: { name: 'Tolu Adebayo', matricNo: 'CSC/21/001', email },
  });
  const { reference, amount } = opened.body.data;
  await payCheckout(fake, reference, { receivedKobo: amount });
  await drainWebhookQueue();
  const receipt = await db.receipt.findFirstOrThrow({ where: { checkout: { reference } } });
  return { receipt, due };
}

describe('public receipts', () => {
  it('verifies a real receipt, with the payer masked, and 404s anything else', async () => {
    const { receipt, due } = await paidGuestReceipt(`v_${Date.now()}@example.com`);

    const res = await api('GET', `/v1/public/receipts/verify/${receipt.number.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      valid: true,
      number: receipt.number,
      payer: 'Tolu A.',
      total: 507_500,
      items: [{ title: due.title, amount: 500_000 }],
    });

    expect((await api('GET', '/v1/public/receipts/verify/RCT-2026-NOPE2345')).status).toBe(404);
    expect((await api('GET', '/v1/public/receipts/verify/garbage')).status).toBe(404);
  });

  it('emails a link (never the data) and the link unlocks only that email', async () => {
    const email = `l_${Date.now()}@example.com`;
    const { receipt } = await paidGuestReceipt(email);

    // Same answer whether or not the email has paid; only a payer gets mail.
    lookupEmail.mockClear();
    const unknown = await api('POST', '/v1/public/receipts/lookup', { body: { email: `nobody_${Date.now()}@example.com` } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.data).toEqual({ sent: true });
    const known = await api('POST', '/v1/public/receipts/lookup', { body: { email: email.toUpperCase() } });
    expect(known.body.data).toEqual({ sent: true });
    await vi.waitFor(() => expect(lookupEmail).toHaveBeenCalledTimes(1));
    const [to, link, count] = lookupEmail.mock.calls[0]!;
    expect(to).toBe(email);
    expect(count).toBe(1);
    const token = new URL(link).searchParams.get('t')!;

    const list = await api('GET', `/v1/public/receipts?t=${encodeURIComponent(token)}`);
    expect(list.status).toBe(200);
    expect(list.body.data.receipts).toEqual([expect.objectContaining({ number: receipt.number })]);

    const pdf = await fetch(`${await startHttp()}/v1/public/receipts/${receipt.number}/pdf?t=${encodeURIComponent(token)}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');

    // Another email's receipt stays shut, and a bad token gets nothing.
    const other = await paidGuestReceipt(`o_${Date.now()}@example.com`);
    const theirs = await fetch(`${await startHttp()}/v1/public/receipts/${other.receipt.number}/pdf?t=${encodeURIComponent(token)}`);
    expect(theirs.status).toBe(404);
    expect((await api('GET', '/v1/public/receipts?t=forged.token')).status).toBe(401);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { buildRepPaymentReceivedEmail, sendRepPaymentReceivedEmail } from '../../lib/email';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp } from './fixtures';

vi.hoisted(() => {
  process.env.TRUST_PROXY = '1';
});

vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendDuePaymentReceiptEmail: vi.fn(async () => {}),
  sendRepPaymentReceivedEmail: vi.fn(async () => {}),
}));
const repEmail = vi.mocked(sendRepPaymentReceivedEmail);

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);
beforeEach(() => {
  repEmail.mockReset().mockResolvedValue(undefined);
});

let ip = 0;
let seq = 0;
async function guestPays(dueId: string) {
  const res = await api('POST', `/v1/public/dues/${dueId}/checkout`, {
    body: { name: 'Ada Guest', matricNo: `MAT${Date.now()}${seq}`, email: `rep_mail_${Date.now()}_${seq++}@test.duevy` },
    headers: { 'X-Forwarded-For': `10.8.${Math.floor(++ip / 250)}.${ip % 250}` },
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const { reference, amount } = res.body.data as { reference: string; amount: number };
  await payCheckout(fake, reference, { receivedKobo: amount, eventId: `txn_repmail_${reference}` });
  await drainWebhookQueue();
  return reference;
}

describe('reps are emailed when a member pays', () => {
  it('emails the rep the payer, dues and face amount', async () => {
    const { rep, space, dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const reference = await guestPays(due.id);

    await vi.waitFor(() => expect(repEmail).toHaveBeenCalled());
    const [to, name, input] = repEmail.mock.calls[0]!;
    expect({ to, name }).toEqual({ to: rep.email, name: rep.name });
    expect(input).toMatchObject({
      spaceName: space.name,
      payerName: 'Ada Guest',
      payerIsGuest: true,
      reference,
      faceKobo: due.amount,
      items: [{ title: due.title, amountKobo: due.amount }],
    });
    expect(input.link).toContain(`/dashboard/create-dues?due=${due.id}`);
  });

  it('skips a rep who turned payment emails off', async () => {
    const { rep, dues } = await makeSpace();
    await db.user.update({
      where: { id: rep.id },
      data: { notificationPrefs: { email: { dueReminders: true, paymentReceipts: false }, push: { dueReminders: true, payments: true, circleActivity: true } } },
    });
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const reference = await guestPays(due.id);

    await vi.waitFor(async () => expect((await db.checkout.findUniqueOrThrow({ where: { reference } })).status).toBe('paid'));
    // afterPaid has had its turn: the in-app notice is there, the email isn't.
    await vi.waitFor(async () => expect(await db.notification.count({ where: { userId: rep.id, kind: 'payment_received' } })).toBeGreaterThan(0));
    expect(repEmail).not.toHaveBeenCalled();
  });
});

describe('buildRepPaymentReceivedEmail', () => {
  it('names the guest payer and escapes what members typed', () => {
    const { subject, html, text } = buildRepPaymentReceivedEmail('Rep <b>', {
      spaceName: 'Food Science',
      payerName: 'Ada <script>',
      payerIsGuest: true,
      reference: 'DVY-ABC',
      items: [{ title: 'Dept dues', amountKobo: 200_000 }],
      faceKobo: 200_000,
      paidAt: new Date('2026-11-10T10:00:00Z'),
      link: 'https://duevy.app/dashboard/create-dues?due=1',
    });
    expect(subject).toBe('Ada <script> (guest) paid ₦2,000.00 — Dept dues');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Ada &lt;script&gt; (guest)');
    expect(text).toContain('Ada <script> (guest) just paid ₦2,000.00 for Dept dues in Food Science.');
  });
});

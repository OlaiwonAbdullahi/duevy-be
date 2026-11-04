import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { koboToDecimal } from '../../lib/money';
import { sendAccountActivationEmail, sendDuePaymentReceiptEmail } from '../../lib/email';
import { guestCheckoutToken } from '../../services/checkout.service';
import { retryGuestAccountInvites } from '../../services/guestAccount.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

// Each test plays a different guest, so give each its own client IP: the
// checkout limiter (10/min per IP) would otherwise see one very busy guest.
vi.hoisted(() => {
  process.env.TRUST_PROXY = '1';
});

// Capture activation links instead of emailing them; keep every other template real.
vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendAccountActivationEmail: vi.fn(async () => {}),
  sendDuePaymentReceiptEmail: vi.fn(async () => {}),
}));
const activationEmail = vi.mocked(sendAccountActivationEmail);
const receiptEmail = vi.mocked(sendDuePaymentReceiptEmail);

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);
beforeEach(() => {
  activationEmail.mockReset().mockResolvedValue(undefined);
  receiptEmail.mockReset().mockResolvedValue(undefined);
});

let seq = 0;
const guestEmail = () => `acct_${Date.now()}_${seq++}@test.duevy`;

async function guestDue() {
  const { rep, space, dues } = await makeSpace();
  const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
  return { rep, space, due };
}

let ip = 0;
const asNewGuest = () => ({ 'X-Forwarded-For': `10.9.${Math.floor(++ip / 250)}.${ip % 250}` });

async function open(dueId: string, body: Record<string, unknown>, token?: string) {
  const res = await api('POST', `/v1/public/dues/${dueId}/checkout`, { body, token, headers: asNewGuest() });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.data as { reference: string; token: string; amount: number; checkoutUrl: string | null };
}

async function pay(reference: string, amountKobo: number, eventId = `evt_acct_${reference}`) {
  await sendWebhook({
    id: eventId,
    type: 'collection.succeeded',
    data: { reference, status: 'SUCCEEDED', amount: koboToDecimal(amountKobo), currency: 'NGN' },
  });
  await drainWebhookQueue();
}

/** afterPaid runs after the webhook commits; wait for its invite to settle. */
async function waitForInvite(reference: string) {
  await vi.waitFor(async () => {
    const c = await db.checkout.findUniqueOrThrow({ where: { reference } });
    expect(c.accountInviteSentAt).not.toBeNull();
  });
}

const statusOf = async (reference: string, token: string) =>
  (await api('GET', `/v1/public/checkouts/${reference}?t=${token}`)).body.data;

describe('new dues start with the default pay form', () => {
  it('stores the phone question when the rep sends no form, and keeps an explicit null', async () => {
    const { rep, space } = await makeSpace();
    const repToken = await tokenFor(rep);
    const dueDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const base = { amount: 200_000, dueDate, category: 'departmental_due', allowGuests: true };

    const created = await api('POST', `/v1/spaces/${space.id}/dues`, { token: repToken, body: { ...base, title: 'Default form' } });
    expect(created.status).toBe(201);
    expect(created.body.data.guestFields).toEqual([{ id: 'phone', label: 'Phone number', type: 'phone', required: false }]);

    const legacy = await api('POST', `/v1/spaces/${space.id}/dues`, {
      token: repToken,
      body: { ...base, title: 'Original form', guestFields: null },
    });
    expect(legacy.body.data.guestFields).toBeNull();

    // Matric number is a core field, so a rep's own matric question is dropped.
    const own = await api('POST', `/v1/spaces/${space.id}/dues`, {
      token: repToken,
      body: { ...base, title: 'Own matric', guestFields: [{ id: 'matric', label: 'Matric', type: 'text', required: false }] },
    });
    expect(own.body.data.guestFields).toEqual([]);
  });
});

describe('matric number is always asked', () => {
  it('requires it from guests, stores it on the guest, and keeps the latest', async () => {
    const { due } = await guestDue();
    const email = guestEmail();
    const missing = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', email }, headers: asNewGuest() });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'matricNo' })]);

    const c = await open(due.id, { name: 'Tolu Ade', matricNo: ' 2021/1234 ', email });
    expect((await db.user.findUniqueOrThrow({ where: { email } })).matricNo).toBe('2021/1234');
    expect((await statusOf(c.reference, c.token)).payer.matricNo).toBe('2021/1234');

    const { due: other } = await guestDue();
    await open(other.id, { name: 'Tolu Ade', matricNo: '2021/9999', email });
    expect((await db.user.findUniqueOrThrow({ where: { email } })).matricNo).toBe('2021/9999');
  });

  it("hides an older form's own matric question so it isn't asked twice", async () => {
    const { due } = await guestDue();
    await db.due.update({
      where: { id: due.id },
      data: { guestFields: [{ id: 'matric', label: 'Matric number', type: 'text', required: true }, { id: 'hall', label: 'Hall', type: 'text', required: false }] },
    });
    const summary = await api('GET', `/v1/public/dues/${due.id}`);
    expect(summary.body.data.fields.map((f: { id: string }) => f.id)).toEqual(['hall']);
    await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail() });
  });

  it("uses a signed-in student's profile matric number, filling it only when missing", async () => {
    const { students } = await makeSpace({ members: 2 });
    const [withNone, withOne] = [students[0]!, students[1]!];
    await db.user.update({ where: { id: withOne.id }, data: { matricNo: 'STU/123' } });
    const { due } = await guestDue();

    // No matric on the profile: it must be given, and fills the profile.
    const none = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'X Y', email: guestEmail() },
      token: await tokenFor(withNone),
    });
    expect(none.body.error.details).toEqual([expect.objectContaining({ field: 'matricNo' })]);
    await open(due.id, { name: 'X Y', email: guestEmail(), matricNo: 'NEW/001' }, await tokenFor(withNone));
    expect((await db.user.findUniqueOrThrow({ where: { id: withNone.id } })).matricNo).toBe('NEW/001');

    // One on the profile: not asked for, and a typed one never overwrites it.
    const c = await open(due.id, { name: 'X Y', email: guestEmail(), matricNo: 'SOMETHING-ELSE' }, await tokenFor(withOne));
    expect((await db.user.findUniqueOrThrow({ where: { id: withOne.id } })).matricNo).toBe('STU/123');
    expect((await statusOf(c.reference, c.token)).payer.matricNo).toBe('STU/123');
  });
});

describe('guest checkout account opt-in', () => {
  it('pays as a guest with no account when the box is left unticked', async () => {
    const { due } = await guestDue();
    const email = guestEmail();
    const c = await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email });
    expect(c.checkoutUrl).toBeTruthy(); // hosted mode: the URL the overlay opens

    await pay(c.reference, c.amount);
    const status = await statusOf(c.reference, c.token);
    expect(status).toMatchObject({
      status: 'paid',
      spaceName: expect.any(String),
      payer: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email },
      account: { exists: false, requested: false, inviteSentAt: null },
    });
    expect(status.id).toBeUndefined();
    expect(activationEmail).not.toHaveBeenCalled();
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.isGuest).toBe(true);
    expect(await db.passwordReset.count({ where: { userId: user.id } })).toBe(0);
  });

  it('creates the account only after payment, once, and lets the guest set their own password', async () => {
    const { rep, space, due } = await guestDue();
    const email = guestEmail();
    const c = await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email, createAccount: true });
    const user = await db.user.findUniqueOrThrow({ where: { email } });

    // Consent is recorded, but nothing is sent while it's unpaid.
    expect((await statusOf(c.reference, c.token)).account).toMatchObject({ requested: true, inviteSentAt: null });
    expect(await db.passwordReset.count({ where: { userId: user.id } })).toBe(0);

    await pay(c.reference, c.amount);
    await waitForInvite(c.reference);
    expect(activationEmail).toHaveBeenCalledTimes(1);
    const [to, , rawToken, opts] = activationEmail.mock.calls[0]!;
    expect(to).toBe(email);
    expect(opts.expiresInHours).toBe(72);
    // Only the hash is stored, never a password.
    const reset = await db.passwordReset.findFirstOrThrow({ where: { userId: user.id } });
    expect(reset.tokenHash).not.toBe(rawToken);
    expect(reset.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBeNull();

    // A duplicate delivery (same event id) and a replay under a new id are both no-ops.
    await pay(c.reference, c.amount);
    await pay(c.reference, c.amount, `evt_acct_replay_${c.reference}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(activationEmail).toHaveBeenCalledTimes(1);
    expect(await db.duePayment.count({ where: { checkoutId: (await db.checkout.findUniqueOrThrow({ where: { reference: c.reference } })).id } })).toBe(1);

    // The link sets their own password; the payment is already theirs.
    const set = await api('POST', '/v1/auth/reset-password', { body: { token: rawToken, password: 'my-own-password-1' } });
    expect(set.status).toBe(200);
    const claimed = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(claimed).toMatchObject({ isGuest: false, emailVerified: true });
    expect(await db.duePayment.findFirst({ where: { userId: user.id, dueId: due.id } })).not.toBeNull();
    const login = await api('POST', '/v1/auth/login', { body: { email, password: 'my-own-password-1' } });
    expect(login.status).toBe(200);

    // Single use.
    const again = await api('POST', '/v1/auth/reset-password', { body: { token: rawToken, password: 'another-password-2' } });
    expect(again.status).toBe(400);
    expect((await statusOf(c.reference, c.token)).account.exists).toBe(true);

    // Activating doesn't make them a member: the roster still shows a guest payment.
    const roster = await api('GET', `/v1/spaces/${space.id}/dues/${due.id}/collections`, { token: await tokenFor(rep) });
    expect(roster.body.data.totals).toMatchObject({ paid: 0, guestPaid: 1 });
    expect(roster.body.data.guests).toEqual([expect.objectContaining({ email, reference: c.reference })]);
  });

  it('never creates the account for an expired or underpaid checkout', async () => {
    const { due } = await guestDue();
    const expired = await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail(), createAccount: true });
    await sendWebhook({ id: `evt_exp_${expired.reference}`, type: 'checkout.expired', data: { reference: expired.reference } });
    await drainWebhookQueue();
    expect((await statusOf(expired.reference, expired.token)).status).toBe('expired');

    const { due: due2 } = await guestDue();
    const short = await open(due2.id, { name: 'Bisi Ola', matricNo: 'CSC/21/001', email: guestEmail(), createAccount: true });
    await sendWebhook({
      id: `evt_short_${short.reference}`,
      type: 'collection.underpaid',
      data: { reference: short.reference, amount_paid: koboToDecimal(1000), amount_expected: koboToDecimal(short.amount) },
    });
    await drainWebhookQueue();
    expect((await statusOf(short.reference, short.token)).status).toBe('underpaid');

    await retryGuestAccountInvites();
    const resend = await api('POST', `/v1/public/checkouts/${short.reference}/account?t=${short.token}`);
    expect(resend.body.data.outcome).toBe('not_paid');
    expect(activationEmail).not.toHaveBeenCalled();
  });

  it('keeps the payment when the invite fails, and the sweep sends it later', async () => {
    const { due } = await guestDue();
    const c = await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail(), createAccount: true });
    activationEmail.mockRejectedValueOnce(new Error('email provider down'));

    await pay(c.reference, c.amount);
    await vi.waitFor(() => expect(activationEmail).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));
    const after = await db.checkout.findUniqueOrThrow({ where: { reference: c.reference } });
    expect(after).toMatchObject({ status: 'paid', accountInviteSentAt: null });

    // Past the sweep's grace period, it retries.
    await db.checkout.update({ where: { id: after.id }, data: { paidAt: new Date(Date.now() - 10 * 60_000) } });
    await retryGuestAccountInvites();
    expect(activationEmail).toHaveBeenCalledTimes(2);
    expect((await db.checkout.findUniqueOrThrow({ where: { id: after.id } })).accountInviteSentAt).not.toBeNull();
  });

  it('lets a guest who paid without the box ask for an account from the success page', async () => {
    const { due } = await guestDue();
    const c = await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail() });
    const path = `/v1/public/checkouts/${c.reference}/account`;
    expect((await api('POST', `${path}?t=wrong`)).status).toBe(404);

    // Before payment: recorded, not sent.
    expect((await api('POST', `${path}?t=${c.token}`)).body.data).toMatchObject({ outcome: 'not_paid', account: { requested: true } });

    await pay(c.reference, c.amount);
    await waitForInvite(c.reference); // afterPaid honours the earlier request
    expect(activationEmail).toHaveBeenCalledTimes(1);

    // Asking again straight away is held by the cooldown.
    expect((await api('POST', `${path}?t=${c.token}`)).body.data.outcome).toBe('already_sent');
    expect(activationEmail).toHaveBeenCalledTimes(1);
  });

  it('reuses the guest row across payments rather than making a second account', async () => {
    const email = guestEmail();
    const { due: first } = await guestDue();
    const { due: second } = await guestDue();
    const a = await open(first.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email, createAccount: true });
    const b = await open(second.id, { name: 'Tolu A.', matricNo: 'CSC/21/001', email, createAccount: true });
    expect(await db.user.count({ where: { email } })).toBe(1);
    const [ca, cb] = await Promise.all([
      db.checkout.findUniqueOrThrow({ where: { reference: a.reference } }),
      db.checkout.findUniqueOrThrow({ where: { reference: b.reference } }),
    ]);
    expect(ca.userId).toBe(cb.userId);
  });

  it('pays as the signed-in account for an existing user, never as a guest', async () => {
    const { students } = await makeSpace();
    const student = students[0]!;
    const { rep, due } = await guestDue(); // a different space: they aren't a member

    // Typing the email of an account without signing in is refused.
    const anon = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'Sola Ade', matricNo: 'CSC/21/001', email: student.email },
      headers: asNewGuest(),
    });
    expect(anon.body.error.code).toBe('EMAIL_HAS_ACCOUNT');

    // Signed in, the session decides who pays — not the typed email.
    const c = await open(due.id, { name: 'Whoever', matricNo: 'CSC/21/001', email: guestEmail(), createAccount: true }, await tokenFor(student));
    const checkout = await db.checkout.findUniqueOrThrow({ where: { reference: c.reference } });
    expect(checkout.userId).toBe(student.id);
    expect(checkout.accountRequestedAt).toBeNull();

    await pay(c.reference, c.amount);
    const status = await statusOf(c.reference, c.token);
    expect(status).toMatchObject({ status: 'paid', account: { exists: true }, payer: { email: student.email } });
    expect(await db.duePayment.count({ where: { userId: student.id, dueId: due.id } })).toBe(1);
    expect((await api('POST', `/v1/public/checkouts/${c.reference}/account?t=${c.token}`)).body.error.code).toBe('ACCOUNT_EXISTS');

    // A signed-in non-member paying through the link is a guest payment on the roster.
    const roster = await api('GET', `/v1/spaces/${due.spaceId}/dues/${due.id}/collections`, { token: await tokenFor(rep) });
    expect(roster.body.data.totals).toMatchObject({ paid: 0, guestPaid: 1 });
  });
});

describe('checkout.completed from the overlay', () => {
  it('reads the payment back from the provider instead of trusting the event', async () => {
    const { due } = await guestDue();
    const c = await open(due.id, { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail() });
    const providerCheckoutId = `chk_fake_${c.reference}`;
    const completed = (id: string) =>
      sendWebhook({ id, type: 'checkout.completed', data: { checkout_id: providerCheckoutId, reference: c.reference } });

    // The provider hasn't seen the money yet: nothing changes.
    await completed(`evt_done1_${c.reference}`);
    await drainWebhookQueue();
    expect((await statusOf(c.reference, c.token)).status).toBe('pending');

    fake.collectionStatus.set(providerCheckoutId, { state: 'paid', receivedKobo: c.amount });
    await completed(`evt_done2_${c.reference}`);
    await drainWebhookQueue();
    expect((await statusOf(c.reference, c.token)).status).toBe('paid');

    // collection.succeeded arriving afterwards records nothing twice.
    await pay(c.reference, c.amount);
    const checkout = await db.checkout.findUniqueOrThrow({ where: { reference: c.reference } });
    expect(await db.duePayment.count({ where: { checkoutId: checkout.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { reference: c.reference } })).toBe(1);
  });
});

describe('the payment confirmation email', () => {
  /** afterPaid runs after the webhook commits; wait for its receipt email. */
  const receiptSentTo = async (email: string) => {
    await vi.waitFor(() => expect(receiptEmail.mock.calls.some(([to]) => to === email)).toBe(true));
    return receiptEmail.mock.calls.find(([to]) => to === email)!;
  };

  it("attaches a guest's receipt PDF and links to their pay-link receipt page", async () => {
    const { due } = await guestDue();
    const email = guestEmail();
    const c = await open(due.id, { name: 'Ada Guest', matricNo: '2021/0001', email });
    await pay(c.reference, c.amount);

    const [, name, input, pdf] = await receiptSentTo(email);
    expect(name).toBe('Ada Guest');
    const receipt = await db.receipt.findFirstOrThrow({ where: { checkout: { reference: c.reference } } });
    expect(pdf?.filename).toBe(`receipt-${receipt.number}.pdf`);
    expect(pdf?.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Same link the pay page itself uses, so it opens without signing in.
    expect(input.receiptUrl).toContain(`/pay/${due.id}?ref=${c.reference}&t=${encodeURIComponent(guestCheckoutToken(c.reference))}`);
    expect(guestCheckoutToken(c.reference)).toBe(c.token);
  });

  it('sends account holders the plain email: their receipt is in the app', async () => {
    const { due } = await guestDue();
    const { rep: member } = await makeSpace();
    const c = await open(due.id, { name: member.name, email: member.email, matricNo: '2021/0003' }, await tokenFor(member));
    await pay(c.reference, c.amount);

    const [, , input, pdf] = await receiptSentTo(member.email);
    expect(pdf).toBeUndefined();
    expect(input.receiptUrl).toBeUndefined();
  });

  it('still sends the email when the PDF fails, without the attachment', async () => {
    const { due } = await guestDue();
    const email = guestEmail();
    const c = await open(due.id, { name: 'Bola Guest', matricNo: '2021/0002', email });
    const receipts = await import('../../services/receipt.service');
    const spy = vi.spyOn(receipts, 'renderReceiptByNumber').mockRejectedValueOnce(new Error('pdf engine down'));
    try {
      await pay(c.reference, c.amount);
      const [, , input, pdf] = await receiptSentTo(email);
      expect(pdf).toBeUndefined();
      expect(input.receiptUrl).toContain(`/pay/${due.id}?ref=${c.reference}`);
    } finally {
      spy.mockRestore();
    }
  });
});

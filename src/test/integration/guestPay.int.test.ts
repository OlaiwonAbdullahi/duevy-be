import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { createCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

let seq = 0;
const guestEmail = () => `guest_${Date.now()}_${seq++}@test.duevy`;

async function pay(reference: string, amountKobo: number) {
  await payCheckout(fake, reference, { receivedKobo: amountKobo });
  await drainWebhookQueue();
}

describe('guest pay', () => {
  it('keeps members-only dues off the public link', async () => {
    const { dues } = await makeSpace();
    const due = dues[0]!;
    expect((await api('GET', `/v1/public/dues/${due.id}`)).status).toBe(404);
    const res = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail() } });
    expect(res.status).toBe(404);
  });

  it('lets a guest pay a guest-enabled due end to end, without an account', async () => {
    const { rep, space, dues } = await makeSpace({ members: 2 });
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const email = guestEmail();

    const summary = await api('GET', `/v1/public/dues/${due.id}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ amount: 500_000, fee: 7_500, total: 507_500, canCollect: true });

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email } });
    expect(opened.status).toBe(201);
    const { reference, token, amount } = opened.body.data;
    expect(amount).toBe(507_500);
    expect(token).toBeTruthy();

    const guest = await db.user.findUniqueOrThrow({ where: { email } });
    expect(guest.isGuest).toBe(true);
    expect(guest.passwordHash).toBeNull();
    expect(await db.spaceMembership.count({ where: { userId: guest.id } })).toBe(0);

    // Asking again reuses the open checkout rather than opening a second account.
    const again = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email } });
    expect(again.status).toBe(200);
    expect(again.body.data.reference).toBe(reference);

    // The status page needs the token.
    expect((await api('GET', `/v1/public/checkouts/${reference}?t=wrong`)).status).toBe(404);
    expect((await api('GET', `/v1/public/checkouts/${reference}?t=${token}`)).body.data.status).toBe('pending');

    await pay(reference, amount);

    const status = await api('GET', `/v1/public/checkouts/${reference}?t=${token}`);
    expect(status.body.data).toMatchObject({ status: 'paid' });
    expect(status.body.data.receiptNumber).toBeTruthy();
    expect(status.body.data.userId).toBeUndefined();
    expect(await getSpaceBalance(space.id)).toBe(500_000);

    const receipt = await fetch(`${await startHttp()}/v1/public/checkouts/${reference}/receipt?t=${token}`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get('content-type')).toContain('application/pdf');

    // The rep sees the guest on their own, and members' paid/unpaid stay honest.
    const repToken = await tokenFor(rep);
    const roster = await api('GET', `/v1/spaces/${space.id}/dues/${due.id}/collections`, { token: repToken });
    expect(roster.status).toBe(200);
    expect(roster.body.data.totals).toMatchObject({ paid: 0, unpaid: 3, guestPaid: 1 });
    expect(roster.body.data.guests).toEqual([expect.objectContaining({ name: 'Tolu Ade', matricNo: 'CSC/21/001', email, reference })]);

    const listed = await api('GET', `/v1/spaces/${space.id}/dues`, { token: repToken });
    expect(listed.body.data.find((d: { id: string }) => d.id === due.id)).toMatchObject({
      allowGuests: true,
      paidCount: 0,
      guestPaidCount: 1,
    });

    // Paying the same due twice with the same email is refused.
    const twice = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email } });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('DUE_ALREADY_PAID');
  });

  it('space-borne fee: student pays only the face, the space absorbs the 1.5%', async () => {
    const { space, dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true, feePayer: 'space' } });
    const email = guestEmail();

    // The public summary charges the student no fee on top.
    const summary = await api('GET', `/v1/public/dues/${due.id}`);
    expect(summary.body.data).toMatchObject({ amount: 500_000, fee: 0, total: 500_000, feePayer: 'space' });

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Ngozi A', matricNo: 'CSC/21/009', email } });
    expect(opened.status).toBe(201);
    const { reference, token, amount } = opened.body.data;
    expect(amount).toBe(500_000); // student transfers only the face

    await pay(reference, amount);

    const status = await api('GET', `/v1/public/checkouts/${reference}?t=${token}`);
    expect(status.body.data).toMatchObject({ status: 'paid' });
    expect(status.body.data.breakdown).toMatchObject({ face: 500_000, fee: 0, total: 500_000 });

    // The space is credited the face less the full fee: ₦5,000 − ₦75 = ₦4,925.
    expect(await getSpaceBalance(space.id)).toBe(492_500);
    const payment = await db.duePayment.findFirstOrThrow({ where: { dueId: due.id } });
    expect(payment).toMatchObject({ amountPaid: 500_000, duevyFee: 7_500, netToSpace: 492_500 });
  });

  it('lets anyone pay as a guest, even with an email that already has an account', async () => {
    const { students, dues } = await makeSpace();
    await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const before = await db.user.count({ where: { email: students[0]!.email } });
    const res = await api('POST', `/v1/public/dues/${dues[0]!.id}/checkout`, {
      body: { name: 'Someone', matricNo: 'CSC/21/001', email: students[0]!.email },
    });
    expect(res.status).toBe(201);
    // The payment attaches to the existing account; no duplicate row is made.
    expect(await db.user.count({ where: { email: students[0]!.email } })).toBe(before);
    const checkout = await db.checkout.findUniqueOrThrow({ where: { reference: res.body.data.reference } });
    expect(checkout.userId).toBe(students[0]!.id);
  });

  it('lets one payer settle a due for several people in one transfer (group pay)', async () => {
    const { rep, space, dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const stamp = `${Date.now()}_${seq++}`;
    const people = [
      { name: 'Ada One', email: `ada_${stamp}@test.duevy`, matricNo: 'CSC/1' },
      { name: 'Bola Two', email: `bola_${stamp}@test.duevy`, matricNo: 'CSC/2' },
      { name: 'Chidi Three', email: `chidi_${stamp}@test.duevy`, matricNo: 'CSC/3' },
    ];

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { people } });
    expect(opened.status).toBe(201);
    const { reference, token, amount } = opened.body.data;
    // Face × 3 plus the 1.5% fee on the whole basket.
    expect(amount).toBe(500_000 * 3 + 22_500);

    await pay(reference, amount);

    // Each person is recorded as their own payer, crediting the space at face.
    expect(await db.duePayment.count({ where: { dueId: due.id } })).toBe(3);
    expect(await getSpaceBalance(space.id)).toBe(500_000 * 3);

    const repToken = await tokenFor(rep);
    const roster = await api('GET', `/v1/spaces/${space.id}/dues/${due.id}/collections`, { token: repToken });
    expect(roster.body.data.totals).toMatchObject({ guestPaid: 3 });
    expect(roster.body.data.guests.map((g: { name: string }) => g.name).sort()).toEqual(['Ada One', 'Bola Two', 'Chidi Three']);

    // One receipt, reachable with the shared token, listing everyone.
    const status = await api('GET', `/v1/public/checkouts/${reference}?t=${token}`);
    expect(status.body.data.status).toBe('paid');
    const receipt = await fetch(`${await startHttp()}/v1/public/checkouts/${reference}/receipt?t=${token}`);
    expect(receipt.status).toBe(200);
  });

  it('refuses a group payment that lists the same email twice', async () => {
    const { dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const dupe = guestEmail();
    const res = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: {
        people: [
          { name: 'Ada One', email: dupe, matricNo: 'CSC/1' },
          { name: 'Ada Again', email: dupe, matricNo: 'CSC/2' },
        ],
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PAYER');
  });

  it('records the payer source account on a paid checkout (for refunds)', async () => {
    const { dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email: guestEmail() },
    });
    const { reference, amount } = opened.body.data;

    await payCheckout(fake, reference, {
      receivedKobo: amount,
      sender: { name: 'Tolu Ade', accountNumber: '0123456789', bank: 'GTBank', bankCode: '058' },
    });
    await drainWebhookQueue();

    const checkout = await db.checkout.findUniqueOrThrow({ where: { reference } });
    expect(checkout).toMatchObject({
      status: 'paid',
      senderAccountNumber: '0123456789',
      senderBankCode: '058',
      senderBank: 'GTBank',
    });
  });

  it('allows a due with no deadline, shown as null everywhere', async () => {
    const { rep, space } = await makeSpace();
    const repToken = await tokenFor(rep);

    const created = await api('POST', `/v1/spaces/${space.id}/dues`, {
      token: repToken,
      body: { title: 'Open Welfare Fund', amount: 200_000, type: 'other', publish: true, allowGuests: true },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'active', dueDate: null });

    // The public pay page is happy with no deadline.
    const pub = await api('GET', `/v1/public/dues/${created.body.data.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.dueDate).toBeNull();
  });

  it("won't let a guest pay a members-only due, even through the service", async () => {
    const { dues } = await makeSpace();
    const guest = await db.user.create({ data: { name: 'G', matricNo: 'CSC/21/001', email: guestEmail(), isGuest: true } });
    await expect(createCheckout(guest.id, [dues[0]!.id], { guest: true })).rejects.toMatchObject({ code: 'GUESTS_NOT_ALLOWED' });
  });

  it('keeps guest accounts out of login and signup until the email is proven', async () => {
    const email = guestEmail();
    await db.user.create({ data: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email, isGuest: true } });

    const login = await api('POST', '/v1/auth/login', { body: { email, password: 'whatever-password' } });
    expect(login.status).toBe(401);

    const signup = await api('POST', '/v1/auth/register', {
      body: { name: 'Tolu Ade', email, password: 'a-strong-password', matricNo: '2021001', acceptedTerms: true },
    });
    expect(signup.status).toBe(409);
    expect(signup.body.error.code).toBe('GUEST_ACCOUNT_EXISTS');
  });

  it('lets a rep turn guest payments on and off', async () => {
    const { rep, space, dues } = await makeSpace();
    const repToken = await tokenFor(rep);
    const on = await api('PATCH', `/v1/spaces/${space.id}/dues/${dues[0]!.id}`, { token: repToken, body: { allowGuests: true } });
    expect(on.status).toBe(200);
    expect(on.body.data.allowGuests).toBe(true);
    expect((await api('GET', `/v1/public/dues/${dues[0]!.id}`)).status).toBe(200);

    await api('PATCH', `/v1/spaces/${space.id}/dues/${dues[0]!.id}`, { token: repToken, body: { allowGuests: false } });
    expect((await api('GET', `/v1/public/dues/${dues[0]!.id}`)).status).toBe(404);
  });

  it("collects the rep's own questions and shows the answers on the roster", async () => {
    const { rep, space, dues } = await makeSpace();
    const repToken = await tokenFor(rep);
    const path = `/v1/spaces/${space.id}/dues/${dues[0]!.id}`;

    const badForm = await api('PATCH', path, {
      token: repToken,
      body: { guestFields: [{ id: 'size', label: 'T-shirt size', type: 'select', options: ['M'] }] },
    });
    expect(badForm.status).toBe(400);

    const fields = [
      { id: 'size', label: 'T-shirt size', type: 'select', required: true, options: ['S', 'M', 'L'] },
      { id: 'phone', label: 'Phone', type: 'phone', required: false },
    ];
    const set = await api('PATCH', path, { token: repToken, body: { allowGuests: true, guestFields: fields } });
    expect(set.status).toBe(200);
    expect(set.body.data.guestFields).toEqual(fields);

    const summary = await api('GET', `/v1/public/dues/${dues[0]!.id}`);
    expect(summary.body.data.fields).toHaveLength(2);

    const checkoutPath = `/v1/public/dues/${dues[0]!.id}/checkout`;
    const email = guestEmail();
    const missing = await api('POST', checkoutPath, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'answers.size' })]);

    const wrong = await api('POST', checkoutPath, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email, answers: { size: 'XXL' } } });
    expect(wrong.status).toBe(400);

    const opened = await api('POST', checkoutPath, { body: { name: 'Tolu Ade', matricNo: 'CSC/21/001', email, answers: { size: 'M', phone: ' ' } } });
    expect(opened.status).toBe(201);
    await pay(opened.body.data.reference, opened.body.data.amount);

    // Renaming the question later doesn't rewrite what the guest answered.
    await api('PATCH', path, { token: repToken, body: { guestFields: [{ ...fields[0], label: 'Size' }] } });
    const roster = await api('GET', `${path}/collections`, { token: repToken });
    expect(roster.body.data.guests[0].answers).toEqual([{ fieldId: 'size', label: 'T-shirt size', value: 'M' }]);

    const csv = await fetch(`${await startHttp()}${path}/collections/export`, { headers: { Authorization: `Bearer ${repToken}` } });
    const [header, ...rows] = (await csv.text()).split('\n');
    expect(header).toBe('Name,Matric No,Level,Email,Paid Via,Amount Paid (NGN),Paid At,Reference,Size');
    expect(rows.find((r) => r.includes(email))).toMatch(/,M$/);
  });
});

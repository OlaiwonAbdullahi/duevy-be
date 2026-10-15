import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { koboToDecimal } from '../../lib/money';
import { createCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { api, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

beforeAll(async () => {
  installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

let seq = 0;
const guestEmail = () => `guest_${Date.now()}_${seq++}@test.duevy`;

async function pay(reference: string, amountKobo: number) {
  await sendWebhook({
    id: `evt_guest_${reference}`,
    type: 'collection.succeeded',
    data: { reference, status: 'SUCCEEDED', amount: koboToDecimal(amountKobo), currency: 'NGN' },
  });
  await drainWebhookQueue();
}

describe('guest pay', () => {
  it('keeps members-only dues off the public link', async () => {
    const { dues } = await makeSpace();
    const due = dues[0]!;
    expect((await api('GET', `/v1/public/dues/${due.id}`)).status).toBe(404);
    const res = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', email: guestEmail() } });
    expect(res.status).toBe(404);
  });

  it('lets a guest pay a guest-enabled due end to end, without an account', async () => {
    const { rep, space, dues } = await makeSpace({ members: 2 });
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const email = guestEmail();

    const summary = await api('GET', `/v1/public/dues/${due.id}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ amount: 500_000, fee: 12_000, total: 512_000, canCollect: true });

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', email } });
    expect(opened.status).toBe(201);
    const { reference, token, amount } = opened.body.data;
    expect(amount).toBe(512_000);
    expect(token).toBeTruthy();

    const guest = await db.user.findUniqueOrThrow({ where: { email } });
    expect(guest.isGuest).toBe(true);
    expect(guest.passwordHash).toBeNull();
    expect(await db.spaceMembership.count({ where: { userId: guest.id } })).toBe(0);

    // Asking again reuses the open checkout rather than opening a second account.
    const again = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', email } });
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
    expect(roster.body.data.guests).toEqual([expect.objectContaining({ name: 'Tolu Ade', email, reference })]);

    const listed = await api('GET', `/v1/spaces/${space.id}/dues`, { token: repToken });
    expect(listed.body.data.find((d: { id: string }) => d.id === due.id)).toMatchObject({
      allowGuests: true,
      paidCount: 0,
      guestPaidCount: 1,
    });

    // Paying the same due twice with the same email is refused.
    const twice = await api('POST', `/v1/public/dues/${due.id}/checkout`, { body: { name: 'Tolu Ade', email } });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('DUE_ALREADY_PAID');
  });

  it('sends people with an account to sign in instead', async () => {
    const { students, dues } = await makeSpace();
    await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const res = await api('POST', `/v1/public/dues/${dues[0]!.id}/checkout`, {
      body: { name: 'Someone', email: students[0]!.email },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_HAS_ACCOUNT');
  });

  it("won't let a guest pay a members-only due, even through the service", async () => {
    const { dues } = await makeSpace();
    const guest = await db.user.create({ data: { name: 'G', email: guestEmail(), isGuest: true } });
    await expect(createCheckout(guest.id, [dues[0]!.id], { guest: true })).rejects.toMatchObject({ code: 'GUESTS_NOT_ALLOWED' });
  });

  it('keeps guest accounts out of login and signup until the email is proven', async () => {
    const email = guestEmail();
    await db.user.create({ data: { name: 'Tolu Ade', email, isGuest: true } });

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
});

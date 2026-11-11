import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout, findCheckoutId, fulfilCheckout } from '../../services/checkout.service';
import { api, creditSpace, installFakeProvider, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

/**
 * The admin's 9jaPay console: the money summary, sweeps, withdrawals,
 * webhook retries and a space's account. Actions only ever move a record the
 * way 9jaPay's own answer says.
 */

let fake: FakeProvider;
let token: string;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  token = await tokenFor(admin);
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

async function collect(s: Awaited<ReturnType<typeof makeSpace>>) {
  const { checkout } = await createCheckout(s.students[0]!.id, [s.dues[0]!.id]);
  await fulfilCheckout(await findCheckoutId(checkout.reference, null), checkout.amount, 0, 'test');
  return checkout;
}

let refSeq = 0;
async function makePayout(spaceId: string, status: 'pending' | 'processing' | 'awaiting_approval') {
  const reference = `WDTEST${Date.now()}${++refSeq}`;
  return db.payout.create({
    data: {
      spaceId,
      amount: 100_000,
      netKobo: 95_000,
      feeKobo: 5_000,
      reference,
      providerPayoutId: reference,
      status,
      accountMasked: 'GTBank •••• 6789',
      accountName: 'ADA OBI',
      ...(status === 'awaiting_approval' ? {} : { activeSpaceId: spaceId }),
    },
  });
}

describe('GET /admin/payments/summary', () => {
  it('splits what spaces are owed into the business account (unswept) and their own accounts', async () => {
    const before = (await api('GET', '/v1/admin/payments/summary', { token })).body.data;
    const s = await makeSpace({ dues: [500_000] });
    await collect(s);
    await creditSpace(s.space.id, 200_000); // not a 9jaPay collection: never counts as unswept

    const res = await api('GET', '/v1/admin/payments/summary', { token });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.provider).toBe('fake');
    expect(d.funds.awaitingSweepKobo - before.funds.awaitingSweepKobo).toBe(500_000);
    expect(d.funds.heldKobo - before.funds.heldKobo).toBe(700_000);
    expect(d.funds.inSpaceAccountsKobo).toBe(d.funds.heldKobo - d.funds.awaitingSweepKobo);
    expect(d.today.checkoutsPaid).toBeGreaterThanOrEqual(1);
    expect(d.pipeline).toMatchObject({
      checkouts: expect.any(Object),
      payouts: expect.any(Object),
      sweeps: expect.any(Object),
      webhooks: expect.any(Object),
      spaces: expect.any(Object),
    });
  });

  it('is refused without a token', async () => {
    expect((await api('GET', '/v1/admin/payments/summary')).status).toBe(401);
  });
});

describe('sweeps', () => {
  it('"Sweep now" moves the collections, lists the sweep, and a recheck applies 9jaPay\'s answer', async () => {
    const s = await makeSpace({ dues: [400_000] });
    await collect(s);

    const swept = await api('POST', `/v1/admin/spaces/${s.space.id}/sweep`, { token });
    expect(swept.status).toBe(200);
    expect(swept.body.data).toMatchObject({ started: 1, amountKobo: 400_000 });
    expect(swept.body.data.money.awaitingSweepKobo).toBe(0);

    const list = await api('GET', `/v1/admin/sweeps?spaceId=${s.space.id}`, { token });
    expect(list.body.data).toHaveLength(1);
    const row = list.body.data[0];
    expect(row).toMatchObject({ amount: 400_000, trigger: 'manual', status: 'processing', space: { id: s.space.id } });

    fake.settleTransfer(row.reference, 'succeeded');
    const rechecked = await api('POST', `/v1/admin/sweeps/${row.id}/recheck`, { token });
    expect(rechecked.body.data.status).toBe('succeeded');

    // Nothing left to move: a second sweep starts nothing.
    const again = await api('POST', `/v1/admin/spaces/${s.space.id}/sweep`, { token });
    expect(again.body.data.started).toBe(0);
    expect(await db.adminAuditLog.count({ where: { action: 'space.swept', target: s.space.id } })).toBe(1);
  });
});

describe('withdrawals', () => {
  it('shows a withdrawal in full', async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'processing');
    const res = await api('GET', `/v1/admin/payouts/${p.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: p.id, status: 'processing', space: { id: s.space.id }, approvals: [], stuck: false });
  });

  it('lists with search, a stuck filter and totals', async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'processing');
    await db.payout.update({ where: { id: p.id }, data: { requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    const res = await api('GET', `/v1/admin/payouts?stuck=true&q=${p.reference}`, { token });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: p.id, stuck: true, spaceShort: 'TST' });
    expect(res.body.meta.totalAmount).toBe(100_000);
  });

  it('recheck applies a transfer 9jaPay settled', async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'processing');
    fake.transfers.set(p.reference, {
      providerReference: p.reference,
      state: 'succeeded',
      failureReason: null,
      input: { from: 'business', bankCode: '058', accountNumber: '0123456789', accountName: 'ADA OBI', amountKobo: 95_000, reference: p.reference, narration: '' },
    });
    const res = await api('POST', `/v1/admin/payouts/${p.id}/recheck`, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('success');
  });

  it('stops a pending withdrawal 9jaPay has no record of, restoring the balance', async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'pending');
    const res = await api('POST', `/v1/admin/payouts/${p.id}/cancel`, { token, body: { reason: 'Wrong account' } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('failed');
    expect(res.body.data.failureReason).toContain('Wrong account');
    expect(await db.ledgerEntry.count({ where: { payoutId: p.id, type: 'payout_reversal' } })).toBe(1);
  });

  it("won't stop a pending withdrawal 9jaPay already has", async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'pending');
    fake.transfers.set(p.reference, {
      providerReference: p.reference,
      state: 'processing',
      failureReason: null,
      input: { from: 'business', bankCode: '058', accountNumber: '0123456789', accountName: 'ADA OBI', amountKobo: 95_000, reference: p.reference, narration: '' },
    });
    const res = await api('POST', `/v1/admin/payouts/${p.id}/cancel`, { token, body: { reason: 'Wrong account' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSFER_EXISTS');
    expect((await db.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('pending');
  });

  it("won't stop one already with the bank", async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'processing');
    const res = await api('POST', `/v1/admin/payouts/${p.id}/cancel`, { token, body: { reason: 'Wrong account' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYOUT_NOT_CANCELLABLE');
  });

  it('cancels one awaiting approval', async () => {
    const s = await makeSpace();
    const p = await makePayout(s.space.id, 'awaiting_approval');
    const res = await api('POST', `/v1/admin/payouts/${p.id}/cancel`, { token, body: { reason: 'Signatories unreachable' } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });
});

describe('webhooks', () => {
  it('lists events without payloads, shows one with it, and requeues a dead one once', async () => {
    const e = await db.webhookEvent.create({
      data: { provider: 'fake', providerEventId: `evt_${Date.now()}`, type: 'transfer', payload: { hello: 'world' }, status: 'dead', attempts: 8, error: 'boom' },
    });
    const list = await api('GET', `/v1/admin/webhooks?status=dead&q=${e.providerEventId}`, { token });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: e.id, status: 'dead', error: 'boom' });
    expect(list.body.data[0].payload).toBeUndefined();

    const one = await api('GET', `/v1/admin/webhooks/${e.id}`, { token });
    expect(one.body.data.payload).toEqual({ hello: 'world' });

    const retried = await api('POST', `/v1/admin/webhooks/${e.id}/retry`, { token });
    expect(retried.body.data).toMatchObject({ status: 'received', attempts: 0 });
    expect((await api('POST', `/v1/admin/webhooks/${e.id}/retry`, { token })).status).toBe(409);
  });
});

describe("a space's 9jaPay account", () => {
  it('shows the account, its funds and recent activity', async () => {
    const s = await makeSpace({ dues: [300_000] });
    await collect(s);
    const res = await api('GET', `/v1/admin/spaces/${s.space.id}/money`, { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      account: { accountNumber: s.space.walletAccountNumber },
      balanceKobo: 300_000,
      awaitingSweepKobo: 300_000,
      inSpaceAccountKobo: 0,
    });
  });

  it('opens a missing account, and the spaces list can find spaces without one', async () => {
    const s = await makeSpace();
    await db.space.update({ where: { id: s.space.id }, data: { walletAccountId: null, walletAccountNumber: null, walletCreatedAt: null } });

    const missing = await api('GET', `/v1/admin/spaces?account=missing&q=${encodeURIComponent(s.space.name)}`, { token });
    expect(missing.body.data.map((r: { id: string }) => r.id)).toContain(s.space.id);

    const res = await api('POST', `/v1/admin/spaces/${s.space.id}/account`, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.account?.accountNumber).toBeTruthy();
  });
});

describe('checkouts', () => {
  it('rechecks a checkout with 9jaPay, and 404s an unknown one', async () => {
    const s = await makeSpace();
    const { checkout } = await createCheckout(s.students[0]!.id, [s.dues[0]!.id]);
    const res = await api('POST', `/v1/admin/checkouts/${checkout.reference}/recheck`, { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reference: checkout.reference, previousStatus: 'pending', status: 'pending', changed: false });

    const list = await api('GET', `/v1/admin/checkouts?q=${checkout.reference}`, { token });
    expect(list.body.data[0].account?.number).toBeTruthy();

    expect((await api('POST', '/v1/admin/checkouts/NOPE/recheck', { token })).status).toBe(404);
  });
});

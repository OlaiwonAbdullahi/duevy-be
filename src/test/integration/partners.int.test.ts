import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { getSpaceLedgerSummary } from '../../services/ledger.service';
import { requestWithdrawal } from '../../services/withdrawal.service';
import { api, creditSpace, installFakeProvider, makeSpace, TEST_PIN, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

let seq = 0;
const code = (prefix = 'P') => `${prefix}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 20);

async function adminToken(perms: { userManagement?: boolean; payouts?: boolean } = {}) {
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({
    data: { userId: admin.id, userManagement: perms.userManagement ?? false, payouts: perms.payouts ?? true, disputes: false, overrides: false },
  });
  return tokenFor(admin);
}

async function makePartner(data: Partial<{ withdrawalFeeDiscountPercent: number; durationDays: number | null; maxRedemptions: number | null; expiresAt: Date | null; isActive: boolean }> = {}) {
  return db.partner.create({
    data: { name: 'Nigeria Association of Computing Students', short: 'NACOS', code: code(), withdrawalFeeDiscountPercent: 50, ...data },
  });
}

describe('admin partners', () => {
  it('creates, lists and edits partners, and needs the payouts permission', async () => {
    const token = await adminToken();
    const c = code('NACOS');
    const created = await api('POST', '/v1/admin/partners', {
      token,
      body: { name: 'NACOS LAUTECH', short: 'NACOS', code: c.toLowerCase(), withdrawalFeeDiscountPercent: 40, durationDays: 180 },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: c, withdrawalFeeDiscountPercent: 40, durationDays: 180, isActive: true, redemptionCount: 0 });

    const dup = await api('POST', '/v1/admin/partners', { token, body: { name: 'Again', short: 'AG', code: c, withdrawalFeeDiscountPercent: 10 } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PARTNER_CODE_TAKEN');

    const list = await api('GET', `/v1/admin/partners?q=${c}`, { token });
    expect(list.body.data.map((p: { code: string }) => p.code)).toEqual([c]);

    const patched = await api('PATCH', `/v1/admin/partners/${created.body.data.id}`, { token, body: { isActive: false } });
    expect(patched.body.data.isActive).toBe(false);

    const noPerm = await adminToken({ payouts: false });
    expect((await api('GET', '/v1/admin/partners', { token: noPerm })).status).toBe(403);
  });
});

describe('partner codes', () => {
  it('previews a code, and rejects unknown, inactive, expired and used-up ones', async () => {
    const p = await makePartner({ durationDays: 90 });
    const ok = await api('GET', `/v1/partners/lookup?code=${p.code.toLowerCase()}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ code: p.code, name: p.name, short: 'NACOS', logoUrl: null, withdrawalFeeDiscountPercent: 50, durationDays: 90 });

    expect((await api('GET', '/v1/partners/lookup?code=NOPE-NOT-REAL')).body.error.code).toBe('INVALID_PARTNER_CODE');
    const inactive = await makePartner({ isActive: false });
    expect((await api('GET', `/v1/partners/lookup?code=${inactive.code}`)).body.error.code).toBe('INVALID_PARTNER_CODE');
    const expired = await makePartner({ expiresAt: new Date(Date.now() - 1000) });
    expect((await api('GET', `/v1/partners/lookup?code=${expired.code}`)).body.error.code).toBe('PARTNER_CODE_EXPIRED');

    const capped = await makePartner({ maxRedemptions: 1 });
    const { rep, space } = await makeSpace();
    expect((await api('POST', `/v1/spaces/${space.id}/partner`, { token: await tokenFor(rep), body: { code: capped.code } })).status).toBe(201);
    const res = await api('GET', `/v1/partners/lookup?code=${capped.code}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PARTNER_CODE_EXHAUSTED');
  });

  it('lets the lead rep apply a code once; co-reps can only read it', async () => {
    const p = await makePartner({ durationDays: 30 });
    const { rep, space } = await makeSpace();
    const lead = await tokenFor(rep);

    expect((await api('GET', `/v1/spaces/${space.id}/partner`, { token: lead })).body.data).toBeNull();

    const co = await db.user.create({ data: { name: 'Co Rep', email: `co_${Date.now()}@test.duevy`, role: 'rep', isRep: true } });
    await db.spaceRep.create({ data: { userId: co.id, spaceId: space.id, role: 'co' } });
    const coToken = await tokenFor(co);
    expect((await api('POST', `/v1/spaces/${space.id}/partner`, { token: coToken, body: { code: p.code } })).status).toBe(403);

    const applied = await api('POST', `/v1/spaces/${space.id}/partner`, { token: lead, body: { code: p.code } });
    expect(applied.status).toBe(201);
    expect(applied.body.data).toMatchObject({ source: 'settings', discountPercent: 50, active: true, partner: { code: p.code } });
    const days = (new Date(applied.body.data.endsAt).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    expect((await api('GET', `/v1/spaces/${space.id}/partner`, { token: coToken })).body.data.id).toBe(applied.body.data.id);

    const again = await api('POST', `/v1/spaces/${space.id}/partner`, { token: lead, body: { code: (await makePartner()).code } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PARTNER_ALREADY_APPLIED');

    const audit = await db.spaceAuditLog.findFirst({ where: { spaceId: space.id, action: 'partner_applied' } });
    expect(audit).not.toBeNull();
  });

  it('is checked at rep signup and redeemed for the space on approval', async () => {
    const p = await makePartner();
    const base = { name: 'Tunde Bello', matricNo: '2019/1234', password: 'password123', acceptedTerms: true, role: 'rep' };
    const space = { name: 'Computer Science', short: 'CSC', kind: 'department', school: 'LAUTECH' };

    const bad = await api('POST', '/v1/auth/register', { body: { ...base, email: `bad_${Date.now()}@test.duevy`, space, partnerCode: 'NOT-A-CODE' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'INVALID_PARTNER_CODE', details: [{ field: 'partnerCode' }] });

    const email = `rep_${Date.now()}@test.duevy`;
    const reg = await api('POST', '/v1/auth/register', { body: { ...base, email, space, partnerCode: p.code.toLowerCase() } });
    expect(reg.status).toBe(403); // REP_APPROVAL_PENDING
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect((await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } })).partnerCode).toBe(p.code);

    await db.user.update({ where: { id: user.id }, data: { kycStatus: 'verified', studentIdStatus: 'pending' } });
    const approved = await api('POST', `/v1/admin/reps/${user.id}/verify`, { token: await adminToken({ userManagement: true }), body: {} });
    expect(approved.status).toBe(200);

    const app = await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } });
    const redemption = await db.partnerRedemption.findUniqueOrThrow({ where: { spaceId: app.spaceId! } });
    expect(redemption).toMatchObject({ partnerId: p.id, source: 'signup', discountPercent: 50, endsAt: null, redeemedById: user.id });
  });
});

describe('discounted withdrawals', () => {
  it('quotes and charges the discounted fee, and keeps the redeemed percent after the partner changes', async () => {
    const p = await makePartner({ withdrawalFeeDiscountPercent: 50 });
    const { rep, space, beneficiary } = await makeSpace();
    const token = await tokenFor(rep);
    await creditSpace(space.id, 5_000_000);
    await api('POST', `/v1/spaces/${space.id}/partner`, { token, body: { code: p.code } });
    // Later edits don't change the space's terms.
    await db.partner.update({ where: { id: p.id }, data: { withdrawalFeeDiscountPercent: 10, isActive: false } });

    const quote = await api('GET', `/v1/spaces/${space.id}/payout/quote?amount=2000000`, { token });
    expect(quote.body.data).toMatchObject({ amount: 2_000_000, feeBeforeDiscount: 10_000, discount: 5_000, discountPercent: 50, fee: 5_000, net: 1_995_000 });

    const summary = await api('GET', `/v1/spaces/${space.id}/payout/summary`, { token });
    expect(summary.body.data.fees.below.feeKobo).toBe(5_000);
    expect(summary.body.data.fees.atOrAbove.feeKobo).toBe(10_000);
    expect(summary.body.data.partner).toMatchObject({ discountPercent: 50, active: true });

    const payout = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 2_000_000, pin: TEST_PIN });
    expect(payout).toMatchObject({ feeKobo: 5_000, netKobo: 1_995_000, feeDiscountKobo: 5_000 });
    expect(payout.partnerRedemptionId).not.toBeNull();
  });

  it('charges no fee at 100% off without writing a zero ledger entry', async () => {
    const p = await makePartner({ withdrawalFeeDiscountPercent: 100 });
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 3_000_000);
    await api('POST', `/v1/spaces/${space.id}/partner`, { token: await tokenFor(rep), body: { code: p.code } });

    const payout = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 2_000_000, pin: TEST_PIN });
    expect(payout).toMatchObject({ feeKobo: 0, netKobo: 2_000_000, feeDiscountKobo: 10_000 });
    expect(await db.ledgerEntry.count({ where: { payoutId: payout.id, type: 'payout_fee' } })).toBe(0);
    expect((await getSpaceLedgerSummary(space.id)).balance).toBe(1_000_000);
  });

  it('goes back to the full fee once the redemption ends or is revoked', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const p = await makePartner();
    const applied = await api('POST', `/v1/spaces/${space.id}/partner`, { token, body: { code: p.code } });

    await db.partnerRedemption.update({ where: { id: applied.body.data.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect((await api('GET', `/v1/spaces/${space.id}/payout/quote?amount=2000000`, { token })).body.data).toMatchObject({ fee: 10_000, discount: 0 });
    expect((await api('GET', `/v1/spaces/${space.id}/partner`, { token })).body.data.active).toBe(false);

    await db.partnerRedemption.update({ where: { id: applied.body.data.id }, data: { endsAt: null } });
    const revoked = await api('POST', `/v1/admin/partner-redemptions/${applied.body.data.id}/revoke`, { token: await adminToken() });
    expect(revoked.body.data.revokedAt).not.toBeNull();
    expect((await api('GET', `/v1/spaces/${space.id}/payout/quote?amount=2000000`, { token })).body.data).toMatchObject({ fee: 10_000, discount: 0 });
    expect((await api('GET', `/v1/spaces/${space.id}/partner`, { token })).body.data).toBeNull();
  });
});

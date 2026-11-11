import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment/fake/FakeProvider';
import { renameSpaceAccounts } from '../../scripts/renameSpaceAccounts';
import { ensureSpaceAccount } from '../../services/sweep.service';
import { api, installFakeProvider, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

const SUFFIXED = /-[BCDFGHJKLMNPQRSTVWXZ]{3}$/;

async function admin(perms: { userManagement?: boolean; payouts?: boolean } = { userManagement: true }) {
  const a = await db.user.create({
    data: { name: 'Admin', email: `adm_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: a.id, payouts: false, disputes: false, userManagement: false, overrides: false, ...perms } });
  return tokenFor(a);
}

/** Registers a rep applicant whose student ID and face capture are on file. */
async function applicant(spaceName: string, school = 'LAUTECH') {
  const email = `applicant_${Date.now()}_${Math.random()}@test.duevy`;
  // Answers 403 REP_APPROVAL_PENDING: the account exists, awaiting review.
  await api('POST', '/v1/auth/register', {
    body: { role: 'rep', name: 'Tunde Co', matricNo: '190401002', email, password: 'correct-horse', acceptedTerms: true, space: { name: spaceName, short: 'CSC', kind: 'department', school } },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.user.update({ where: { id: user.id }, data: { studentIdStatus: 'pending', livenessStatus: 'pending' } });
  return user;
}

describe('space account names: "DUEVY/<space name>-<3 letters>"', () => {
  it('a new space account gets a unique suffix, even when another space has the same name', async () => {
    const a = await makeSpace();
    const b = await makeSpace();
    const name = `Computer Science ${Date.now()}`;
    for (const s of [a, b]) {
      await db.space.update({
        where: { id: s.space.id },
        data: { name, walletAccountId: null, walletAccountNumber: null, walletAccountName: null, walletBankName: null, walletBankCode: null, walletCreatedAt: null },
      });
    }
    const first = await ensureSpaceAccount(a.space.id);
    const second = await ensureSpaceAccount(b.space.id);
    expect(first.walletAccountName).toMatch(new RegExp(`^DUEVY/${name}-[A-Z]{3}$`));
    expect(second.walletAccountName).toMatch(SUFFIXED);
    expect(second.walletAccountName).not.toBe(first.walletAccountName);
  });

  it('the rename script renames old-style accounts through the provider, and a re-run does nothing', async () => {
    const { space } = await makeSpace(); // fixture names it "DUEVY/Space <id>", the old form
    const lines: string[] = [];

    const dry = await renameSpaceAccounts(false, (l) => lines.push(l));
    expect(dry.renamed).toBe(0);
    expect((await db.space.findUniqueOrThrow({ where: { id: space.id } })).walletAccountName).toBe(`DUEVY/${space.name}`);

    const before = fake.calls.length;
    const applied = await renameSpaceAccounts(true, (l) => lines.push(l));
    expect(applied.failed).toBe(0);
    const after = await db.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(after.walletAccountName).toMatch(new RegExp(`^DUEVY/${space.name}-[A-Z]{3}$`));
    expect(after.walletAccountNumber).toBe(space.walletAccountNumber);
    expect(fake.calls.slice(before)).toContainEqual({ op: 'renameSpaceAccount', args: { accountNumber: space.walletAccountNumber, accountName: after.walletAccountName!.slice('DUEVY/'.length) } });

    const again = await renameSpaceAccounts(true, () => {});
    expect(again.total).toBe(0);
  });

  it('renaming the space renames its bank account', async () => {
    const { space } = await makeSpace();
    const adm = await admin();
    const res = await api('PATCH', `/v1/admin/spaces/${space.id}`, { token: adm, body: { name: 'Renamed Department' } });
    expect(res.status).toBe(200);
    await expect.poll(async () => (await db.space.findUniqueOrThrow({ where: { id: space.id } })).walletAccountName).toMatch(/^DUEVY\/Renamed Department-[A-Z]{3}$/);
  });
});

describe('approving a rep applicant as a co-rep of an existing department', () => {
  it('shows matching spaces, then adds the applicant as a co-rep without opening a new space', async () => {
    const { rep: lead, space } = await makeSpace();
    const user = await applicant(space.name.toLowerCase());
    const adm = await admin();
    const spacesBefore = await db.space.count();

    const detail = await api('GET', `/v1/admin/reps/${user.id}/application`, { token: adm });
    expect(detail.status).toBe(200);
    expect(detail.body.data.matchingSpaces.map((s: { id: string }) => s.id)).toContain(space.id);

    const res = await api('POST', `/v1/admin/reps/${user.id}/approve-as-co-rep`, { token: adm, body: { spaceId: space.id } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.space).toEqual({ id: space.id, name: space.name, role: 'co' });

    expect(await db.space.count()).toBe(spacesBefore);
    expect(await db.spaceRep.findUnique({ where: { userId_spaceId: { userId: user.id, spaceId: space.id } } })).toMatchObject({ role: 'co', isSignatory: false });
    expect(await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId: user.id, spaceId: space.id } } })).toBeTruthy();
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      role: 'rep', isRep: true, repApplicationStatus: 'approved', studentIdStatus: 'approved', livenessStatus: 'approved',
    });
    expect(await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ status: 'approved', spaceId: null });
    // The lead is still the lead, and hears about it.
    expect(await db.spaceRep.findUnique({ where: { userId_spaceId: { userId: lead.id, spaceId: space.id } } })).toMatchObject({ role: 'lead' });
    expect(await db.notification.findFirst({ where: { userId: lead.id, title: 'New co-rep' } })).toBeTruthy();
    expect(await db.adminAuditLog.count({ where: { action: 'rep.approve_as_co_rep', target: user.id } })).toBe(1);

    // A second click is refused, not applied twice.
    const twice = await api('POST', `/v1/admin/reps/${user.id}/approve-as-co-rep`, { token: adm, body: { spaceId: space.id } });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('NOT_PENDING');
  });

  it('holds the applicant to the same KYC bar as /verify, and refuses archived spaces', async () => {
    const { space } = await makeSpace();
    const user = await applicant('Physics');
    const adm = await admin();
    await db.user.update({ where: { id: user.id }, data: { livenessStatus: null } });

    const early = await api('POST', `/v1/admin/reps/${user.id}/approve-as-co-rep`, { token: adm, body: { spaceId: space.id } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('KYC_INCOMPLETE');

    await db.user.update({ where: { id: user.id }, data: { livenessStatus: 'pending' } });
    await db.space.update({ where: { id: space.id }, data: { isArchived: true } });
    const archived = await api('POST', `/v1/admin/reps/${user.id}/approve-as-co-rep`, { token: adm, body: { spaceId: space.id } });
    expect(archived.status).toBe(404);
    expect(await db.spaceRep.count({ where: { userId: user.id } })).toBe(0);
  });

  it('needs userManagement', async () => {
    const { space } = await makeSpace();
    const user = await applicant('Chemistry');
    const adm = await admin({ payouts: true });
    const res = await api('POST', `/v1/admin/reps/${user.id}/approve-as-co-rep`, { token: adm, body: { spaceId: space.id } });
    expect(res.status).toBe(403);
  });
});

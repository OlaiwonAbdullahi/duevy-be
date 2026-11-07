import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { verifyPassword } from '../../lib/password';
import { api, installFakeProvider, startHttp, stopHttp, tokenFor } from './fixtures';

beforeAll(async () => {
  installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

async function adminToken() {
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  return tokenFor(admin);
}

const space = { name: 'Computer Science', short: 'CSC', kind: 'department', school: 'University of Lagos' };
const signup = (email: string, extra: Record<string, unknown> = {}) =>
  api('POST', '/v1/auth/register', {
    body: { role: 'rep', name: 'Ada Rep', matricNo: '190401001', email, password: 'correct-horse', acceptedTerms: true, space, ...extra },
  });

describe('withdrawal code chosen at rep signup', () => {
  it('is carried onto the space when the application is approved', async () => {
    const email = `rep_pin_${Date.now()}@test.duevy`;
    await signup(email, { withdrawalPin: '2580' });

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const app = await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } });
    expect(app.withdrawalPinHash).toBeTruthy();
    expect(app.withdrawalPinHash).not.toContain('2580');

    await db.user.update({ where: { id: user.id }, data: { kycStatus: 'verified', studentIdStatus: 'pending' } });
    const approved = await api('POST', `/v1/admin/reps/${user.id}/verify`, { token: await adminToken(), body: {} });
    expect(approved.status).toBe(200);

    const { spaceId } = await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } });
    const created = await db.space.findUniqueOrThrow({ where: { id: spaceId! } });
    expect(created.withdrawalPinSetAt).toBeTruthy();
    expect(await verifyPassword('2580', created.withdrawalPinHash!)).toBe(true);
  });

  it('stays optional, and refuses weak or malformed codes', async () => {
    const email = `rep_nopin_${Date.now()}@test.duevy`;
    await signup(email);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect((await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } })).withdrawalPinHash).toBeNull();

    for (const pin of ['1234', '0000', '12a4', '123']) {
      const res = await signup(`rep_bad_${pin}_${Date.now()}@test.duevy`, { withdrawalPin: pin });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

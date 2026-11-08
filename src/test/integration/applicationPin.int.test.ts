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

const PASSWORD = 'correct-horse';
const space = { name: 'Computer Science', short: 'CSC', kind: 'department', school: 'University of Lagos' };

/** A rep applicant (pending application, no space yet) and their session. */
async function applicant() {
  const email = `rep_pin_${Date.now()}_${Math.random()}@test.duevy`;
  await api('POST', '/v1/auth/register', {
    body: { role: 'rep', name: 'Ada Rep', matricNo: '190401001', email, password: PASSWORD, acceptedTerms: true, space },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return { user, token: await tokenFor(user) };
}

describe('withdrawal code chosen during rep onboarding', () => {
  it('is saved on the application and carried onto the space on approval', async () => {
    const { user, token } = await applicant();
    expect((await api('GET', '/v1/me/withdrawal-pin', { token })).body.data).toEqual({ withdrawalPinSet: false });

    const saved = await api('PUT', '/v1/me/withdrawal-pin', { token, body: { pin: '2580', password: PASSWORD } });
    expect(saved.status).toBe(200);
    expect((await api('GET', '/v1/me/withdrawal-pin', { token })).body.data).toEqual({ withdrawalPinSet: true });
    // Re-saving while pending replaces it.
    await api('PUT', '/v1/me/withdrawal-pin', { token, body: { pin: '3691', password: PASSWORD } });

    await db.user.update({ where: { id: user.id }, data: { kycStatus: 'verified', studentIdStatus: 'pending', livenessStatus: 'pending' } });
    expect((await api('POST', `/v1/admin/reps/${user.id}/verify`, { token: await adminToken(), body: {} })).status).toBe(200);

    const { spaceId } = await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } });
    const created = await db.space.findUniqueOrThrow({ where: { id: spaceId! } });
    expect(created.withdrawalPinSetAt).toBeTruthy();
    expect(await verifyPassword('3691', created.withdrawalPinHash!)).toBe(true);

    // Approved: the code now lives on the space and is changed there.
    expect((await api('PUT', '/v1/me/withdrawal-pin', { token, body: { pin: '2580', password: PASSWORD } })).body.error.code).toBe('NOT_PENDING');
  });

  it('needs the password and refuses weak or malformed codes', async () => {
    const { user, token } = await applicant();
    const put = (pin: string, password = PASSWORD) => api('PUT', '/v1/me/withdrawal-pin', { token, body: { pin, password } });

    expect((await put('2580', 'wrong-password')).body.error.code).toBe('INVALID_PASSWORD');
    expect((await put('1234')).body.error.code).toBe('WEAK_PIN');
    expect((await put('0000')).body.error.code).toBe('WEAK_PIN');
    expect((await put('12a4')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await db.repApplication.findUniqueOrThrow({ where: { userId: user.id } })).withdrawalPinHash).toBeNull();
  });

  it('is not available to someone without a pending application', async () => {
    const student = await db.user.create({ data: { name: 'Stu', email: `stu_${Date.now()}@test.duevy`, role: 'student' } });
    expect((await api('GET', '/v1/me/withdrawal-pin', { token: await tokenFor(student) })).status).toBe(404);
  });
});

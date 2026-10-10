import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { api, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

beforeAll(startHttp);
afterAll(stopHttp);

async function adminToken(perms: { userManagement: boolean } = { userManagement: true }) {
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({
    data: { userId: admin.id, userManagement: perms.userManagement, payouts: false, disputes: false, overrides: false },
  });
  return tokenFor(admin);
}

describe('product feedback', () => {
  it('lets a signed-in user send feedback, and an admin read, resolve and reopen it', async () => {
    const { students } = await makeSpace({ members: 1 });
    const student = students[0]!;
    const token = await tokenFor(student);

    const anon = await api('POST', '/v1/feedback', { body: { category: 'bug', message: 'Something broke here' } });
    expect(anon.status).toBe(401);

    const tooShort = await api('POST', '/v1/feedback', { token, body: { category: 'bug', message: 'bad' } });
    expect(tooShort.status).toBe(400);

    const sent = await api('POST', '/v1/feedback', {
      token,
      headers: { 'User-Agent': 'vitest-agent' },
      body: { category: 'bug', message: '  The pay button spins forever on my phone.  ', page: '/dashboard/dues' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({
      category: 'bug',
      message: 'The pay button spins forever on my phone.',
      page: '/dashboard/dues',
      status: 'new',
      userAgent: 'vitest-agent',
      user: { id: student.id, email: student.email },
    });
    const id = sent.body.data.id as string;

    // Needs the userManagement permission.
    const noPerm = await api('GET', '/v1/admin/feedback', { token: await adminToken({ userManagement: false }) });
    expect(noPerm.status).toBe(403);
    expect((await api('GET', '/v1/admin/feedback', { token })).status).toBe(403);

    const admin = await adminToken();
    const inbox = await api('GET', '/v1/admin/feedback?status=new&category=bug&q=spins', { token: admin });
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((f: { id: string }) => f.id)).toContain(id);
    expect(inbox.body.meta.unresolved).toBeGreaterThanOrEqual(1);

    const resolved = await api('POST', `/v1/admin/feedback/${id}/resolve`, { token: admin, body: { note: 'Fixed in 1.4' } });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ status: 'resolved', adminNote: 'Fixed in 1.4' });
    expect(resolved.body.data.resolvedAt).toBeTruthy();
    const stillNew = await api('GET', '/v1/admin/feedback?status=new&q=spins', { token: admin });
    expect(stillNew.body.data.map((f: { id: string }) => f.id)).not.toContain(id);

    const reopened = await api('POST', `/v1/admin/feedback/${id}/reopen`, { token: admin });
    expect(reopened.body.data).toMatchObject({ status: 'new', resolvedAt: null });

    const audit = await db.adminAuditLog.findMany({ where: { target: id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['feedback.resolve', 'feedback.reopen']);

    expect((await api('POST', '/v1/admin/feedback/nope/resolve', { token: admin, body: {} })).status).toBe(404);
  });
});

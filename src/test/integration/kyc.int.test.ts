import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { MemoryFileStore, setFileStore } from '../../lib/storage';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout } from '../../services/checkout.service';
import { api, apiMultipart, installFakeProvider, makeSpace, PNG_BYTES, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
const store = new MemoryFileStore();
beforeAll(async () => {
  fake = installFakeProvider();
  setFileStore(store);
  await startHttp();
});
afterAll(stopHttp);

const NIN = '12345678901';
const DOB = '2001-04-12';
const card = { bytes: PNG_BYTES, name: 'my-card.png', type: 'image/png' };

async function adminToken() {
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  return tokenFor(admin);
}

describe('rep KYC: NIN at Bachs + student ID reviewed by Duevy', () => {
  it('collects only after Bachs verifies the NIN AND an admin approves the student ID; never stores the NIN', async () => {
    const { rep, space, students, dues } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    const submitted = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: NIN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.body.data).toMatchObject({ kycStatus: 'pending', canCollect: false, studentId: { status: 'pending' } });
    expect(JSON.stringify(submitted.body)).not.toContain(NIN);

    // Bachs got the NIN as a typed identifier, no BVN.
    const call = fake.calls.find((c) => c.op === 'verifyIdentity')!;
    expect(JSON.stringify(call.args)).not.toContain(NIN); // the test double redacts too
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user.studentIdFileId).toBeTruthy();
    expect(store.files.get(user.studentIdFileId!)?.buffer.equals(PNG_BYTES)).toBe(true);

    // Bachs verifies.
    fake.identityByAccount.set(user.bachsAccountId!, { status: 'verified', payoutsActive: true });
    await sendWebhook({
      id: `evt_cap_${rep.id}`,
      type: 'capability.updated',
      account: user.bachsAccountId!,
      data: { account: user.bachsAccountId!, capability: 'payouts', status: 'active', requested: true },
    });
    await drainWebhookQueue();
    expect((await db.user.findUniqueOrThrow({ where: { id: rep.id } })).kycStatus).toBe('verified');

    // Still can't collect: the student ID isn't approved yet.
    await expect(createCheckout(students[0]!.id, [dues[0]!.id])).rejects.toMatchObject({ code: 'SPACE_NOT_VERIFIED' });

    // Admin sees it with a short-lived link, and approves.
    const admin = await adminToken();
    const queue = await api('GET', '/v1/admin/kyc/student-ids?status=pending', { token: admin });
    expect(queue.status).toBe(200);
    const row = queue.body.data.find((r: { userId: string }) => r.userId === rep.id);
    expect(row.studentId.viewUrl).toMatch(/expires=/);
    const review = await api('POST', `/v1/admin/users/${rep.id}/student-id/review`, { token: admin, body: { decision: 'approved' } });
    expect(review.status).toBe(200);
    expect(review.body.data).toMatchObject({ canCollect: true, studentId: { status: 'approved' } });

    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    expect(checkout.status).toBe('pending');

    // Nothing in the database holds the NIN or the date of birth.
    const hits = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT row_to_json(u)::text AS t FROM users u
         UNION ALL SELECT row_to_json(w)::text FROM webhook_events w
         UNION ALL SELECT row_to_json(i)::text FROM idempotency_keys i
         UNION ALL SELECT row_to_json(a)::text FROM admin_audit_logs a
       ) x WHERE t LIKE '%${NIN}%' OR t LIKE '%${DOB}%'`,
    );
    expect(Number(hits[0]!.n)).toBe(0);
  });

  it('a rejected student ID can be replaced; the old file is deleted', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    const first = (await db.user.findUniqueOrThrow({ where: { id: rep.id } })).studentIdFileId!;

    const admin = await adminToken();
    const noReason = await api('POST', `/v1/admin/users/${rep.id}/student-id/review`, { token: admin, body: { decision: 'rejected' } });
    expect(noReason.status).toBe(400);
    await api('POST', `/v1/admin/users/${rep.id}/student-id/review`, { token: admin, body: { decision: 'rejected', note: 'Blurry' } });

    const again = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc/student-id`, { token, files: { studentIdCard: card } });
    expect(again.status).toBe(202);
    expect(again.body.data.studentId.status).toBe('pending');
    const second = (await db.user.findUniqueOrThrow({ where: { id: rep.id } })).studentIdFileId!;
    expect(second).not.toBe(first);
    expect(store.files.has(first)).toBe(false);
  });

  it('forwards a government ID to Bachs, and reports what Bachs still asks for', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    fake.requirementsDue = ['persons.per_x.id_document'];
    const res = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: NIN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card, governmentId: { bytes: PNG_BYTES, name: 'nin-slip.png', type: 'image/png' } },
    });
    expect(res.status).toBe(202);
    expect(res.body.data.requirementsDue).toEqual(['persons.per_x.id_document']);
    expect(res.body.data.governmentIdSubmittedAt).toBeTruthy();
    expect(fake.calls.some((c) => c.op === 'uploadIdentityDocument')).toBe(true);
    fake.requirementsDue = [];
  });

  it('validates input without echoing it, rejects non-images, requires the card, refuses non-reps', async () => {
    const { rep, space, students } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    const bad = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: '1234', dob: DOB, gender: 'female' }, files: { studentIdCard: card } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('1234');

    const noCard = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, dob: DOB, gender: 'female' } });
    expect(noCard.status).toBe(400);
    expect(noCard.body.error.details[0].field).toBe('studentIdCard');

    // Claims to be a PNG, isn't.
    const fakeImage = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: NIN, dob: DOB, gender: 'female' },
      files: { studentIdCard: { bytes: Buffer.from('<script>alert(1)</script>'.padEnd(64, ' ')), name: 'x.png', type: 'image/png' } },
    });
    expect(fakeImage.status).toBe(400);

    const student = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token: await tokenFor(students[0]!),
      fields: { nin: NIN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card },
    });
    expect(student.status).toBe(403);
  });

  it('blocks publishing dues until the lead rep can collect, but allows drafts', async () => {
    const { rep, space } = await makeSpace({ verified: false, dues: [] });
    const token = await tokenFor(rep);
    const draft = await api('POST', `/v1/spaces/${space.id}/dues`, {
      token,
      body: { title: 'CSC 201 Handout', amount: 150_000, dueDate: '2099-01-01', type: 'handout' },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: 'draft', type: 'handout' });

    const publish = await api('POST', `/v1/spaces/${space.id}/dues/${draft.body.data.id}/publish`, { token });
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe('KYC_REQUIRED');
  });
});

describe('rep KYC: payout_destination requirement', () => {
  it("sends the rep's own bank account to Bachs and clears the requirement", async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    fake.requirementsDue = ['payout_destination'];

    const before = await api('POST', '/v1/me/kyc/payout-destination', {
      token,
      body: { bankCode: '058', accountNumber: '0123456789' },
    });
    expect(before.status).toBe(409);
    expect(before.body.error.code).toBe('KYC_NOT_STARTED');

    const submitted = await apiMultipart('/v1/me/kyc', {
      token,
      fields: { nin: NIN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card },
    });
    expect(submitted.body.data.requirementsDue).toEqual(['payout_destination']);

    const res = await api('POST', '/v1/me/kyc/payout-destination', {
      token,
      body: { bankCode: '058', accountNumber: '0123456789' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.requirementsDue).toEqual([]);
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(fake.calls.find((c) => c.op === 'submitAccountPayoutDestination')?.args).toMatchObject({
      accountId: user.bachsAccountId,
      bankCode: '058',
    });
    expect(user.kycRequirementsDue).toEqual([]);
  });
});


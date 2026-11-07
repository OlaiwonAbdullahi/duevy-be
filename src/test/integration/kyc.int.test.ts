import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { MemoryFileStore, setFileStore } from '../../lib/storage';
import { type FakeVerifier } from '../../providers/identity';
import { createCheckout } from '../../services/checkout.service';
import { DEFAULT_KYC_POLICY, setKycPolicy } from '../../services/kycPolicy.service';
import { api, apiMultipart, installFakeProvider, installFakeVerifier, makeSpace, PNG_BYTES, startHttp, stopHttp, tokenFor } from './fixtures';

let verifier: FakeVerifier;
const store = new MemoryFileStore();
// This suite covers the NIN path, so it runs with NIN required and the face
// capture off; the default policy (student ID + face capture, NIN optional)
// is covered in kycPolicy.int.test.ts.
beforeAll(async () => {
  installFakeProvider();
  verifier = installFakeVerifier();
  setFileStore(store);
  await setKycPolicy('test', { ninRequired: true, livenessRequired: false });
  await startHttp();
});
beforeEach(() => verifier.reset());
afterAll(async () => {
  await setKycPolicy('test', DEFAULT_KYC_POLICY);
  await stopHttp();
});

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

/** Nothing in the database holds the NIN or the date of birth. */
async function assertNeverStored() {
  const hits = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM (
       SELECT row_to_json(u)::text AS t FROM users u
       UNION ALL SELECT row_to_json(w)::text FROM webhook_events w
       UNION ALL SELECT row_to_json(i)::text FROM idempotency_keys i
       UNION ALL SELECT row_to_json(a)::text FROM admin_audit_logs a
     ) x WHERE t LIKE '%${NIN}%' OR t LIKE '%${DOB}%'`,
  );
  expect(Number(hits[0]!.n)).toBe(0);
}

describe('rep KYC: NIN + date of birth checked by Didit, student ID reviewed by Duevy', () => {
  it('collects only after the NIN matches AND an admin approves the student ID; never stores the NIN', async () => {
    const { rep, space, students, dues } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    // Older clients still send gender; it's ignored, not refused.
    const submitted = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: NIN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.body.data).toMatchObject({ kycStatus: 'verified', canCollect: false, nin: { outcome: 'match' }, studentId: { status: 'pending' } });
    expect(JSON.stringify(submitted.body)).not.toContain(NIN);

    // Checked under the rep's own name; the test double never keeps the NIN.
    expect(verifier.calls.at(-1)).toEqual({ userId: rep.id, firstName: 'Ada', lastName: 'Obi' });
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user.studentIdFileId).toBeTruthy();
    expect(user.diditRequestId).toMatch(/^req_fake_/);
    expect(store.files.get(user.studentIdFileId!)?.buffer.equals(PNG_BYTES)).toBe(true);

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
    await assertNeverStored();
  });

  it('a partial match waits for an admin, who can approve or reject it', async () => {
    const admin = await adminToken();
    for (const decision of ['approved', 'rejected'] as const) {
      const { rep, space } = await makeSpace({ verified: false });
      const token = await tokenFor(rep);
      verifier.outcome = 'partial';
      const submitted = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, dob: DOB }, files: { studentIdCard: card } });
      expect(submitted.status).toBe(202);
      expect(submitted.body.data).toMatchObject({ kycStatus: 'pending', nin: { outcome: 'partial', reviewStatus: 'pending' } });

      // Can't resubmit while it's being reviewed.
      const again = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, dob: DOB }, files: { studentIdCard: card } });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('KYC_PENDING');

      const queue = await api('GET', '/v1/admin/kyc/nin-reviews', { token: admin });
      const row = queue.body.data.find((r: { userId: string }) => r.userId === rep.id);
      expect(row).toMatchObject({ nameMatchScore: 0.62, reviewStatus: 'pending' });
      expect(JSON.stringify(queue.body)).not.toContain(NIN);

      if (decision === 'rejected') {
        const noReason = await api('POST', `/v1/admin/users/${rep.id}/nin/review`, { token: admin, body: { decision } });
        expect(noReason.status).toBe(400);
      }
      const res = await api('POST', `/v1/admin/users/${rep.id}/nin/review`, {
        token: admin,
        body: decision === 'rejected' ? { decision, note: 'Name on the NIN is a different person' } : { decision },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ kycStatus: decision === 'approved' ? 'verified' : 'rejected', nin: { reviewStatus: decision } });
      const u = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
      expect(u.kycAttempts).toBe(decision === 'rejected' ? 1 : 0);
      const twice = await api('POST', `/v1/admin/users/${rep.id}/nin/review`, { token: admin, body: { decision: 'approved' } });
      expect(twice.status).toBe(409);
    }
    await assertNeverStored();
  });

  it('a no-match uses up an attempt (3 lock retries for a day); an outage does not', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    const submit = () => apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, dob: DOB }, files: { studentIdCard: card } });

    verifier.outcome = 'unavailable';
    const down = await submit();
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('KYC_PROVIDER_UNAVAILABLE');
    expect((await db.user.findUniqueOrThrow({ where: { id: rep.id } })).kycAttempts).toBe(0);

    // The verifier refusing the request as we built it (e.g. a name it can't
    // read) is not the rep's failure either: no attempt, no lockout, ever.
    verifier.outcome = 'invalid_input';
    for (let i = 0; i < 4; i++) {
      const refused = await submit();
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('KYC_INPUT_UNREADABLE');
    }
    const afterRefusals = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(afterRefusals).toMatchObject({ kycAttempts: 0, kycRetryLockedUntil: null, studentIdFileId: null });

    verifier.outcome = 'no_match';
    for (let i = 1; i <= 3; i++) {
      const res = await submit();
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('KYC_REJECTED');
    }
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user).toMatchObject({ kycAttempts: 3, kycStatus: 'rejected', ninCheckOutcome: 'no_match' });
    expect(user.kycRetryLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // No student ID was kept for a refused check.
    expect(user.studentIdFileId).toBeNull();

    verifier.outcome = 'match';
    const locked = await submit();
    expect(locked.status).toBe(429);
    await assertNeverStored();
  });

  it('a rep verified on Bachs before the switch carries over: no re-verification', async () => {
    const { rep, space, students, dues } = await makeSpace({ verified: false });
    // As the migration leaves them: verified, student ID approved, Bachs ids kept as history.
    await db.user.update({
      where: { id: rep.id },
      data: { kycStatus: 'verified', studentIdStatus: 'approved', bachsAccountId: `acct_${rep.id}`, bachsPersonId: `per_${rep.id}`, ninCheckOutcome: null },
    });
    const state = await api('GET', `/v1/spaces/${space.id}/payout/kyc-status`, { token: await tokenFor(rep) });
    expect(state.body.data).toMatchObject({ kycStatus: 'verified', canCollect: true, canWithdraw: true });
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    expect(checkout.status).toBe('pending');
    expect(verifier.calls).toHaveLength(0);
  });

  it('a rejected student ID can be replaced; the old file is deleted', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, dob: DOB }, files: { studentIdCard: card } });
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

describe('rep KYC: retired Bachs steps', () => {
  it('no longer serves the government ID and payout-destination steps', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    const res = await api('POST', '/v1/me/kyc/payout-destination', { token, body: { bankCode: '058', accountNumber: '0123456789' } });
    expect(res.status).toBe(404);
  });
});

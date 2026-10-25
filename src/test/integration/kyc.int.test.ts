import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { MemoryFileStore, setFileStore } from '../../lib/storage';
import { DiditError, type IdCheckInput, type IdCheckResult, type PhoneCheckResult } from '../../lib/didit';
import { ProviderError } from '../../providers/payment';
import { createCheckout } from '../../services/checkout.service';
import { api, apiMultipart, installPaymentDouble, makeSpace, PNG_BYTES, startHttp, stopHttp, tokenFor } from './fixtures';

// Didit is mocked at its client: these tests are about what Duevy does with
// its answers. The wire format is covered by src/lib/didit.test.ts.
const didit = vi.hoisted(() => ({
  verifyIdNumber: vi.fn<(input: IdCheckInput) => Promise<IdCheckResult>>(),
  sendPhoneCode: vi.fn<(...args: unknown[]) => Promise<'sent' | 'blocked'>>(),
  checkPhoneCode: vi.fn<(...args: unknown[]) => Promise<PhoneCheckResult>>(),
}));
vi.mock('../../lib/didit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/didit')>()),
  ...didit,
}));

const bank78 = installPaymentDouble();
const store = new MemoryFileStore();
beforeAll(async () => {
  setFileStore(store);
  await startHttp();
});
beforeEach(() => {
  bank78.reset();
  didit.verifyIdNumber
    .mockReset()
    .mockImplementation(async (i) => ({ kind: i.kind, outcome: 'approved', requestId: `didit_${i.kind}_1`, matchType: 'full_match', reason: null }));
  didit.sendPhoneCode.mockReset().mockResolvedValue('sent');
  didit.checkPhoneCode.mockReset().mockResolvedValue({ outcome: 'approved', message: null });
});
afterAll(stopHttp);

const NIN = '12345678901';
const BVN = '22222222221';
const DOB = '2001-04-12';
const PHONE = '08031234567';
const card = { bytes: PNG_BYTES, name: 'my-card.png', type: 'image/png' };

async function adminToken() {
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  return tokenFor(admin);
}

async function verifyPhone(token: string) {
  expect((await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: PHONE } })).status).toBe(202);
  const res = await api('POST', '/v1/me/kyc/phone/verify', { token, body: { phone: PHONE, code: '123456' } });
  expect(res.status).toBe(200);
  return res;
}

describe('rep KYC: phone + NIN with Didit, student ID reviewed by Duevy', () => {
  it('collects only after the phone and NIN pass AND an admin approves the student ID; never stores the NIN', async () => {
    const { rep, space, students, dues } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    const phone = await verifyPhone(token);
    expect(phone.body.data.phone).toMatchObject({ number: '+2348031234567' });
    expect(didit.checkPhoneCode).toHaveBeenCalledWith(rep.id, '+2348031234567', '123456');

    const submitted = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.body.data).toMatchObject({ kycStatus: 'verified', canCollect: false, providerReference: 'didit_nin_1', studentId: { status: 'pending' } });
    expect(submitted.body.data.wallet.accountNumber).toBeTruthy();
    expect(JSON.stringify(submitted.body)).not.toContain(NIN);
    expect(JSON.stringify(submitted.body)).not.toContain(BVN);
    expect(didit.verifyIdNumber).toHaveBeenCalledWith(expect.objectContaining({ kind: 'nin', number: NIN, dob: DOB, firstName: 'Ada', lastName: 'Obi' }));
    expect(didit.verifyIdNumber).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bvn', number: BVN }));

    // The wallet opened at Bank78 with the verified phone and the BVN (the double redacts both numbers).
    const wallet = bank78.calls.find((c) => c.op === 'createWallet')!;
    expect(wallet.args).toMatchObject({ userId: rep.id, phone: '+2348031234567', bvn: '[redacted]' });
    expect(JSON.stringify(wallet.args)).not.toContain(NIN);
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
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

    // Nothing in the database holds the NIN, the BVN or the date of birth.
    const hits = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT row_to_json(u)::text AS t FROM users u
         UNION ALL SELECT row_to_json(w)::text FROM webhook_events w
         UNION ALL SELECT row_to_json(i)::text FROM idempotency_keys i
         UNION ALL SELECT row_to_json(a)::text FROM admin_audit_logs a
       ) x WHERE t LIKE '%${NIN}%' OR t LIKE '%${BVN}%' OR t LIKE '%${DOB}%'`,
    );
    expect(Number(hits[0]!.n)).toBe(0);
  });

  it('refuses the NIN step until the phone is verified', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    const res = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' }, files: { studentIdCard: card } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED');
    expect(didit.verifyIdNumber).not.toHaveBeenCalled();
  });

  it('phone: a wrong code, a declined number and a blocked send are each refused', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    expect((await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: '+14155552671' } })).status).toBe(400);

    didit.checkPhoneCode.mockResolvedValueOnce({ outcome: 'wrong_code', message: 'Attempts remaining: 2' });
    const wrong = await api('POST', '/v1/me/kyc/phone/verify', { token, body: { phone: PHONE, code: '000000' } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('INVALID_CODE');

    didit.checkPhoneCode.mockResolvedValueOnce({ outcome: 'declined', message: null });
    const declined = await api('POST', '/v1/me/kyc/phone/verify', { token, body: { phone: PHONE, code: '000000' } });
    expect(declined.body.error.code).toBe('PHONE_DECLINED');

    didit.sendPhoneCode.mockResolvedValueOnce('blocked');
    const blocked = await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: PHONE } });
    expect(blocked.status).toBe(429);

    didit.sendPhoneCode.mockRejectedValueOnce(new DiditError('down', 502, 'phone_provider_unavailable', true));
    expect((await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: PHONE } })).status).toBe(503);

    expect((await db.user.findUniqueOrThrow({ where: { id: rep.id } })).phoneVerifiedAt).toBeNull();
  });

  it('a declined NIN counts toward the retry lock; the third locks retries for 24h', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    didit.verifyIdNumber.mockResolvedValue({ kind: 'nin', outcome: 'declined', requestId: 'r', matchType: 'no_match', reason: 'The name or date of birth does not match the NIN record' });

    for (let i = 1; i <= 3; i++) {
      const res = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' }, files: { studentIdCard: card } });
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ kycStatus: 'rejected', wallet: null, rejectionReason: 'The name or date of birth does not match the NIN record' });
    }
    const locked = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' }, files: { studentIdCard: card } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('KYC_RETRY_LOCKED');
    expect(bank78.calls.some((c) => c.op === 'createWallet')).toBe(false);
    // The NIN failed each time, so the (billed) BVN check never ran.
    expect(didit.verifyIdNumber.mock.calls.every(([i]) => i.kind === 'nin')).toBe(true);
  });

  it('a declined BVN rejects the rep even when the NIN passed', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    didit.verifyIdNumber.mockImplementation(async (i) =>
      i.kind === 'bvn'
        ? { kind: 'bvn', outcome: 'declined', requestId: 'rb', matchType: 'no_match', reason: 'No record was found for that BVN' }
        : { kind: 'nin', outcome: 'approved', requestId: 'rn', matchType: 'full_match', reason: null },
    );
    const res = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' }, files: { studentIdCard: card } });
    expect(res.body.data).toMatchObject({ kycStatus: 'rejected', wallet: null, rejectionReason: 'No record was found for that BVN' });
  });

  it('an undecided NIN (registry unavailable) stays pending and can be resubmitted without counting', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    didit.verifyIdNumber.mockResolvedValueOnce({ kind: 'nin', outcome: 'in_review', requestId: 'r1', matchType: null, reason: null });
    const first = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    expect(first.body.data.kycStatus).toBe('pending');
    const again = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    expect(again.body.data.kycStatus).toBe('verified');
    expect((await db.user.findUniqueOrThrow({ where: { id: rep.id } })).kycAttempts).toBe(0);
  });

  it('Didit being down is a 503 and does not count as an attempt', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    didit.verifyIdNumber.mockRejectedValueOnce(new DiditError('down', 502, 'empty_provider_response', true));
    const res = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    expect(res.status).toBe(503);
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user.kycAttempts).toBe(0);
    expect(user.studentIdFileId).toBeNull();
  });

  it('a wallet Bank78 could not open is opened when the rep submits again, keeping the reviewed card', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    bank78.failNextWallet = new ProviderError('timeout', null, null, true);
    const res = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    expect(res.body.data).toMatchObject({ kycStatus: 'verified', wallet: null, canCollect: false });
    await db.user.update({ where: { id: rep.id }, data: { studentIdStatus: 'approved' } });
    const card1 = (await db.user.findUniqueOrThrow({ where: { id: rep.id } })).studentIdFileId;

    const again = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    expect(again.status).toBe(202);
    expect(again.body.data).toMatchObject({ kycStatus: 'verified', canCollect: true, studentId: { status: 'approved' } });
    expect(again.body.data.wallet.accountNumber).toBeTruthy();
    expect((await db.user.findUniqueOrThrow({ where: { id: rep.id } })).studentIdFileId).toBe(card1);

    const third = await apiMultipart('/v1/me/kyc', { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('a rejected student ID can be replaced; the old file is deleted', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'male' }, files: { studentIdCard: card } });
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
    await verifyPhone(token);

    const bad = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: '1234', dob: DOB, gender: 'female' }, files: { studentIdCard: card } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('1234');

    const noCard = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' } });
    expect(noCard.status).toBe(400);
    expect(noCard.body.error.details[0].field).toBe('studentIdCard');

    // Claims to be a PNG, isn't.
    const fakeImage = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' },
      files: { studentIdCard: { bytes: Buffer.from('<script>alert(1)</script>'.padEnd(64, ' ')), name: 'x.png', type: 'image/png' } },
    });
    expect(fakeImage.status).toBe(400);

    const student = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token: await tokenFor(students[0]!),
      fields: { nin: NIN, bvn: BVN, dob: DOB, gender: 'female' },
      files: { studentIdCard: card },
    });
    expect(student.status).toBe(403);
    expect(didit.verifyIdNumber).not.toHaveBeenCalled();
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

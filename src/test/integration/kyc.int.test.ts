import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { MemoryFileStore, setFileStore } from '../../lib/storage';
import { ProviderError, type FakeProvider } from '../../providers/payment';
import { FakeVerifier, setIdentityVerifier } from '../../providers/identity';
import { createCheckout } from '../../services/checkout.service';
import { api, apiMultipart, installFakeProvider, makeSpace, PNG_BYTES, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
const verifier = new FakeVerifier();
const store = new MemoryFileStore();
beforeAll(async () => {
  fake = installFakeProvider();
  setIdentityVerifier(verifier);
  setFileStore(store);
  await startHttp();
});
beforeEach(() => {
  fake.reset();
  verifier.reset();
});
afterAll(stopHttp);

const DOB = '2001-04-12';
const card = { bytes: PNG_BYTES, name: 'my-card.png', type: 'image/png' };
let seq = 0;
/** A fresh BVN and Nigerian mobile number per call, so tests never collide on the uniqueness rules. */
const bvn = () => `2${String(Date.now()).slice(-6)}${String(++seq).padStart(4, '0')}`;
const phone = () => `080${String(Date.now()).slice(-4)}${String(++seq).padStart(4, '0')}`;
const fields = (b: string, extra: Record<string, string> = {}) => ({ bvn: b, dob: DOB, gender: 'female', address: '12 Ogbomoso Road, Oyo', consent: 'true', ...extra });

async function adminToken() {
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  return tokenFor(admin);
}

/** Step 1 for a rep: send the code and enter it. Returns the number in E.164. */
async function verifyPhone(token: string, number = phone()) {
  expect((await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: number } })).status).toBe(200);
  const res = await api('POST', '/v1/me/kyc/phone/verify', { token, body: { code: verifier.validCode } });
  expect(res.status).toBe(200);
  return `+234${number.slice(1)}`;
}

describe('rep KYC: phone → BVN (Didit) → Kredi, then admin approval', () => {
  it('collects only after phone + BVN pass AND an admin approves the student ID; never stores the BVN or DOB', async () => {
    const { rep, space, students, dues } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    const b = bvn();

    // BVN before the phone is refused, and nothing is checked or billed.
    const early = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: fields(b), files: { studentIdCard: card } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PHONE_NOT_VERIFIED');
    expect(verifier.calls.some((c) => c.op === 'validateBvn')).toBe(false);

    const verifiedPhone = await verifyPhone(token);
    const state = await api('GET', '/v1/me/kyc-status', { token });
    expect(state.body.data.steps).toMatchObject({ phone: { verified: true }, bvn: { verified: false }, account: { created: false } });
    expect(JSON.stringify(state.body)).not.toContain(verifiedPhone); // masked

    const submitted = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: fields(b), files: { studentIdCard: card } });
    expect(submitted.status).toBe(202);
    expect(submitted.body.data).toMatchObject({
      kycStatus: 'verified',
      canCollect: false,
      steps: { phone: { verified: true }, bvn: { verified: true }, account: { created: true } },
      studentId: { status: 'pending' },
    });
    expect(JSON.stringify(submitted.body)).not.toContain(b);

    // Kredi got the verified phone and the BVN — and only after Didit matched it.
    const ops = [...verifier.calls.map((c) => c.op), ...fake.calls.map((c) => c.op)];
    expect(ops).toContain('validateBvn');
    const kredi = fake.calls.filter((c) => c.op === 'verifyIdentity');
    expect(kredi).toHaveLength(1);
    expect(kredi[0]!.args).toMatchObject({ profile: { phone: verifiedPhone }, gender: 'female' });
    expect(JSON.stringify(kredi[0]!.args)).not.toContain(b); // the test double redacts too

    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user).toMatchObject({ verifiedPhone, kycStatus: 'verified', payoutsActive: true });
    expect(user.providerAccountId).toMatch(/^cus_fake_/);
    expect(user.bvnHash).toMatch(/^[0-9a-f]{64}$/);
    expect(user.diditBvnRequestId).toBeTruthy();
    expect(store.files.get(user.studentIdFileId!)?.buffer.equals(PNG_BYTES)).toBe(true);

    // Still can't collect: the student ID isn't approved yet.
    await expect(createCheckout(students[0]!.id, [dues[0]!.id])).rejects.toMatchObject({ code: 'SPACE_NOT_VERIFIED' });

    // Admin sees the checks and a short-lived link to the card, and approves.
    const admin = await adminToken();
    const queue = await api('GET', '/v1/admin/kyc/student-ids?status=pending', { token: admin });
    const row = queue.body.data.find((r: { userId: string }) => r.userId === rep.id);
    expect(row.studentId.viewUrl).toMatch(/expires=/);
    const review = await api('POST', `/v1/admin/users/${rep.id}/student-id/review`, { token: admin, body: { decision: 'approved' } });
    expect(review.status).toBe(200);
    expect(review.body.data).toMatchObject({ canCollect: true, studentId: { status: 'approved' } });

    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    expect(checkout.status).toBe('pending');

    // Nothing in the database holds the BVN or the date of birth.
    const hits = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT row_to_json(u)::text AS t FROM users u
         UNION ALL SELECT row_to_json(w)::text FROM webhook_events w
         UNION ALL SELECT row_to_json(i)::text FROM idempotency_keys i
         UNION ALL SELECT row_to_json(a)::text FROM admin_audit_logs a
       ) x WHERE t LIKE '%${b}%' OR t LIKE '%${DOB}%'`,
    );
    expect(Number(hits[0]!.n)).toBe(0);
  });

  it('a BVN that does not match counts as a failed attempt and never reaches Kredi', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);

    verifier.bvnOutcome = 'no_match';
    const res = await apiMultipart('/v1/me/kyc', { token, fields: fields(bvn()), files: { studentIdCard: card } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KYC_REJECTED');
    expect(fake.calls.some((c) => c.op === 'verifyIdentity')).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user).toMatchObject({ kycStatus: 'rejected', kycAttempts: 1, bvnVerifiedAt: null, providerAccountId: null });
    // The card uploaded with the failed attempt isn't kept.
    expect(user.studentIdFileId).toBeNull();

    verifier.bvnOutcome = 'partial';
    expect((await apiMultipart('/v1/me/kyc', { token, fields: fields(bvn()), files: { studentIdCard: card } })).status).toBe(422);
    expect((await db.user.findUniqueOrThrow({ where: { id: rep.id } })).kycAttempts).toBe(2);
  });

  it('an unavailable registry or an unknown BVN costs no attempt', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);

    verifier.bvnOutcome = 'unavailable';
    const down = await apiMultipart('/v1/me/kyc', { token, fields: fields(bvn()), files: { studentIdCard: card } });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('VERIFICATION_UNAVAILABLE');

    verifier.bvnOutcome = 'invalid';
    const unknown = await apiMultipart('/v1/me/kyc', { token, fields: fields(bvn()), files: { studentIdCard: card } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('BVN_INVALID');

    expect(await db.user.findUniqueOrThrow({ where: { id: rep.id } })).toMatchObject({ kycAttempts: 0, kycStatus: 'unverified' });
    expect(fake.calls.some((c) => c.op === 'verifyIdentity')).toBe(false);
  });

  it('keeps a BVN match when Kredi is briefly down, so resubmitting is not billed twice', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    const b = bvn();

    fake.failNextIdentity = new ProviderError('timeout', null, null, true);
    const first = await apiMultipart('/v1/me/kyc', { token, fields: fields(b), files: { studentIdCard: card } });
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe('ACCOUNT_SETUP_PENDING');
    expect(await db.user.findUniqueOrThrow({ where: { id: rep.id } })).toMatchObject({ kycStatus: 'pending', providerAccountId: null });

    const again = await apiMultipart('/v1/me/kyc', { token, fields: fields(b), files: { studentIdCard: card } });
    expect(again.status).toBe(202);
    expect(again.body.data.kycStatus).toBe('verified');
    expect(verifier.calls.filter((c) => c.op === 'validateBvn')).toHaveLength(1);
  });

  it('one BVN and one phone number per rep account', async () => {
    const a = await makeSpace({ verified: false });
    const b = await makeSpace({ verified: false });
    const tokenA = await tokenFor(a.rep);
    const tokenB = await tokenFor(b.rep);
    const number = phone();
    const sharedBvn = bvn();

    await verifyPhone(tokenA, number);
    expect((await apiMultipart('/v1/me/kyc', { token: tokenA, fields: fields(sharedBvn), files: { studentIdCard: card } })).status).toBe(202);

    const samePhone = await api('POST', '/v1/me/kyc/phone/send', { token: tokenB, body: { phone: number } });
    expect(samePhone.status).toBe(409);
    expect(samePhone.body.error.code).toBe('PHONE_IN_USE');

    await verifyPhone(tokenB);
    const sameBvn = await apiMultipart('/v1/me/kyc', { token: tokenB, fields: fields(sharedBvn), files: { studentIdCard: card } });
    expect(sameBvn.status).toBe(409);
    expect(sameBvn.body.error.code).toBe('BVN_IN_USE');
    expect(verifier.calls.filter((c) => c.op === 'validateBvn')).toHaveLength(1);
  });

  it('phone codes: wrong code, throttled resend, declined numbers, non-Nigerian numbers', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    expect((await api('POST', '/v1/me/kyc/phone/verify', { token, body: { code: '123456' } })).body.error.code).toBe('NO_PENDING_PHONE');
    expect((await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: '+14155552671' } })).status).toBe(400);

    const number = phone();
    expect((await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: number } })).body.data).toMatchObject({ expiresInSeconds: 300 });
    const resend = await api('POST', '/v1/me/kyc/phone/send', { token, body: { phone: number } });
    expect(resend.status).toBe(429);
    expect(resend.body.error.code).toBe('OTP_RESEND_TOO_SOON');

    const wrong = await api('POST', '/v1/me/kyc/phone/verify', { token, body: { code: '000000' } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('INVALID_OTP');

    verifier.nextCheckOutcome = 'declined';
    const voip = await api('POST', '/v1/me/kyc/phone/verify', { token, body: { code: verifier.validCode } });
    expect(voip.body.error.code).toBe('PHONE_DECLINED');
    expect(await db.user.findUniqueOrThrow({ where: { id: rep.id } })).toMatchObject({ phoneVerifiedAt: null, pendingPhone: null });
  });

  it('a rejected student ID can be replaced; the old file is deleted', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);
    await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: fields(bvn(), { gender: 'male' }), files: { studentIdCard: card } });
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

  it('validates input without echoing it, needs consent and the card, refuses non-reps', async () => {
    const { rep, space, students } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    await verifyPhone(token);

    const bad = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: fields('1234'), files: { studentIdCard: card } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('1234');

    const { consent: _c, ...noConsentFields } = fields(bvn());
    const noConsent = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: noConsentFields, files: { studentIdCard: card } });
    expect(noConsent.status).toBe(400);

    const noCard = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, { token, fields: fields(bvn()) });
    expect(noCard.status).toBe(400);
    expect(noCard.body.error.details[0].field).toBe('studentIdCard');

    // Claims to be a PNG, isn't.
    const fakeImage = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: fields(bvn()),
      files: { studentIdCard: { bytes: Buffer.from('<script>alert(1)</script>'.padEnd(64, ' ')), name: 'x.png', type: 'image/png' } },
    });
    expect(fakeImage.status).toBe(400);

    const student = await api('POST', '/v1/me/kyc/phone/send', { token: await tokenFor(students[0]!), body: { phone: phone() } });
    expect(student.status).toBe(403);
    expect(verifier.calls.some((c) => c.op === 'validateBvn')).toBe(false);
  });

  it('admin final approval needs the phone and BVN checks to have passed', async () => {
    const applicant = await db.user.create({
      data: { name: 'Tolu Ade', email: `app_${Date.now()}@test.duevy`, repApplicationStatus: 'pending', studentIdStatus: 'pending' },
    });
    await db.repApplication.create({
      data: { userId: applicant.id, spaceName: 'Computer Science', spaceShort: 'CSC', spaceKind: 'department', school: 'LAUTECH', faculty: 'FET', theme: 'emerald' },
    });
    const admin = await adminToken();
    const early = await api('POST', `/v1/admin/reps/${applicant.id}/verify`, { token: admin, body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('KYC_INCOMPLETE');

    const detail = await api('GET', `/v1/admin/reps/${applicant.id}/application`, { token: admin });
    expect(detail.status).toBe(200);
    expect(detail.body.data.kyc.identity).toMatchObject({ phone: { verifiedAt: null }, bvn: { verifiedAt: null }, kredi: { registered: false } });
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

describe("rep KYC: the rep's own bank account", () => {
  it('is name-checked and kept masked, with no provider call', async () => {
    const { rep } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    const res = await api('POST', '/v1/me/kyc/payout-destination', { token, body: { bankCode: '058', accountNumber: '0123456789' } });
    expect(res.status).toBe(200);
    expect(res.body.data.payoutDestination).toMatchObject({ bankCode: '058', accountName: 'ADA OBI' });
    expect(res.body.data.payoutDestination.accountNumber).not.toContain('0123456789');
    expect(fake.calls.map((c) => c.op)).toEqual(['resolveAccount']);
  });
});

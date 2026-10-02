import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

const BVN = '22345678901';

describe('rep KYC', () => {
  it('submits, is confirmed by webhook, and never stores the BVN anywhere', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    const submitted = await api('POST', `/v1/spaces/${space.id}/payout/kyc`, {
      token,
      body: { bvn: BVN, dob: '2001-04-12', gender: 'female' },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.body.data).toMatchObject({ kycStatus: 'pending', canCollect: false });
    expect(JSON.stringify(submitted.body)).not.toContain(BVN);

    const user = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(user.bachsAccountId).toBeTruthy();
    expect(user.bachsPersonId).toBeTruthy(); // the provider reference

    // The provider decides; its event only says "look again".
    fake.identityByAccount.set(user.bachsAccountId!, { status: 'verified', payoutsActive: true });
    await sendWebhook({
      id: `evt_cap_${rep.id}`,
      type: 'capability.updated',
      account: user.bachsAccountId!,
      data: { account: user.bachsAccountId!, capability: 'payouts', status: 'active', requested: true },
    });
    await drainWebhookQueue();

    const verified = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(verified.kycStatus).toBe('verified');
    expect(verified.bachsPayoutsActive).toBe(true);

    // Nothing in the database holds the BVN or the date of birth.
    const hits = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT row_to_json(u)::text AS t FROM users u
         UNION ALL SELECT row_to_json(w)::text FROM webhook_events w
         UNION ALL SELECT row_to_json(i)::text FROM idempotency_keys i
         UNION ALL SELECT row_to_json(a)::text FROM space_audit_logs a
       ) x WHERE t LIKE '%${BVN}%' OR t LIKE '%2001-04-12%'`,
    );
    expect(Number(hits[0]!.n)).toBe(0);
  });

  it('validates input without echoing it, and refuses non-reps', async () => {
    const { rep, space, students } = await makeSpace({ verified: false });
    const bad = await api('POST', `/v1/spaces/${space.id}/payout/kyc`, {
      token: await tokenFor(rep),
      body: { bvn: '1234', dob: '2001-04-12', gender: 'female' },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('1234');

    const student = await api('POST', `/v1/spaces/${space.id}/payout/kyc`, {
      token: await tokenFor(students[0]!),
      body: { bvn: BVN, dob: '2001-04-12', gender: 'female' },
    });
    expect(student.status).toBe(403);
  });

  it('blocks publishing dues until the lead rep is verified, but allows drafts', async () => {
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { ProviderError, type FakeProvider } from '../../providers/payment';
import { getSpaceBalance, getSpaceLedgerSummary } from '../../services/ledger.service';
import { completePayout, failPayoutByReference, requestWithdrawal } from '../../services/withdrawal.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { api, creditSpace, installFakeProvider, makeSpace, newKey, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

describe('ledger balance', () => {
  it('is derived from entries: collections − withdrawals − fees, restored by a reversal', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 3_000_000); // ₦30,000
    await creditSpace(space.id, 2_500_000); // ₦25,000
    expect(await getSpaceBalance(space.id)).toBe(5_500_000);

    // ₦20,000 withdrawal: ₦100 fee, ₦19,900 sent, ₦20,000 debited.
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 2_000_000 });
    expect(p.status).toBe('processing');
    expect({ fee: p.feeKobo, net: p.netKobo }).toEqual({ fee: 10_000, net: 1_990_000 });
    expect(await getSpaceBalance(space.id)).toBe(3_500_000);
    expect(fake.calls.find((c) => c.op === 'initiatePayout')?.args).toMatchObject({ amountKobo: 1_990_000, reference: p.reference });

    await completePayout(p.reference, 5_000);
    const summary = await getSpaceLedgerSummary(space.id);
    expect(summary).toMatchObject({ balance: 3_500_000, collected: 5_500_000, withdrawn: 1_990_000, withdrawalFees: 10_000, inFlight: 0 });
    // Duevy's fee less Bachs's own ₦50 payout fee is moved to the platform.
    expect(fake.calls.find((c) => c.op === 'settleFee')?.args).toMatchObject({ amountKobo: 5_000 });

    // A bank reversal after success restores the full ₦20,000.
    await failPayoutByReference(p.reference, 'returned by the bank');
    const reversed = await db.payout.findUniqueOrThrow({ where: { id: p.id } });
    expect(reversed.status).toBe('reversed');
    expect(await getSpaceBalance(space.id)).toBe(5_500_000);
    // A second failure report changes nothing.
    await failPayoutByReference(p.reference, 'again');
    expect(await getSpaceBalance(space.id)).toBe(5_500_000);
  });

  it('is append-only: the database refuses UPDATE and DELETE', async () => {
    const { space } = await makeSpace();
    await creditSpace(space.id, 100_000);
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { spaceId: space.id } });
    await expect(db.ledgerEntry.update({ where: { id: entry.id }, data: { amountKobo: 1 } })).rejects.toThrow(/append-only/);
    await expect(db.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`UPDATE "ledger_entries" SET "amountKobo" = 1 WHERE "spaceId" = '${space.id}'`)).rejects.toThrow();
    expect(await getSpaceBalance(space.id)).toBe(100_000);
  });
});

describe('withdrawals', () => {
  it('locks: of five concurrent requests exactly one goes through', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 10_000_000); // ₦100,000
    fake.payoutDelayMs = 150; // hold the first in flight while the others arrive

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() => requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 6_000_000 })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'WITHDRAWAL_IN_PROGRESS' });

    expect(await db.payout.count({ where: { spaceId: space.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(4_000_000);
    expect(fake.calls.filter((c) => c.op === 'initiatePayout')).toHaveLength(1);
  });

  it('refuses more than the balance, and a second withdrawal while one is in flight', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    await expect(requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 1_000_001 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 200_000 });
    await expect(requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 200_000 })).rejects.toMatchObject({
      code: 'WITHDRAWAL_IN_PROGRESS',
    });
    expect(await getSpaceBalance(space.id)).toBe(800_000);
  });

  it('a provider refusal fails the withdrawal and restores the balance', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    fake.failNextPayout = new ProviderError('Insufficient balance', 400, 'INSUFFICIENT_BALANCE', false);
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 500_000 });
    expect(p.status).toBe('failed');
    expect(p.failureReason).toMatch(/settling/);
    expect(await getSpaceBalance(space.id)).toBe(1_000_000);
    // The lock is released: a new withdrawal can start.
    const next = await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 500_000 });
    expect(next.status).toBe('processing');
  });

  it('a timeout leaves the withdrawal pending (never assumed failed) for reconciliation to resend', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    fake.failNextPayout = new ProviderError('timeout', null, null, true);
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 500_000 });
    expect(p.status).toBe('pending');
    expect(await getSpaceBalance(space.id)).toBe(500_000); // still debited
  });

  it('payout webhooks: success settles; failure restores the balance; duplicates are no-ops', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 2_000_000);
    const a = await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 1_000_000 });
    await sendWebhook({ id: `evt_pp_${a.reference}`, type: 'payout.paid', data: { withdrawal_id: a.providerPayoutId, reference: a.reference, status: 'completed' } });
    await sendWebhook({ id: `evt_pp_${a.reference}`, type: 'payout.paid', data: { withdrawal_id: a.providerPayoutId, reference: a.reference, status: 'completed' } });
    await drainWebhookQueue();
    expect((await db.payout.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('success');

    const b = await requestWithdrawal({ spaceId: space.id, userId: rep.id, amountKobo: 500_000 });
    await sendWebhook({ id: `evt_pf_${b.reference}`, type: 'payout.failed', data: { withdrawal_id: b.providerPayoutId, reference: b.reference, status: 'failed' } });
    await drainWebhookQueue();
    expect((await db.payout.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('failed');
    expect(await getSpaceBalance(space.id)).toBe(1_000_000);
  });

  it('HTTP: the Idempotency-Key replays the first response and never creates a second withdrawal', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    const token = await tokenFor(rep);
    const key = newKey();
    const path = `/v1/spaces/${space.id}/payout/request`;

    const first = await api('POST', path, { token, idempotencyKey: key, body: { amount: 300_000 } });
    expect(first.status).toBe(201);
    const replay = await api('POST', path, { token, idempotencyKey: key, body: { amount: 300_000 } });
    expect(replay.status).toBe(201);
    expect(replay.body.data.reference).toBe(first.body.data.reference);
    const reused = await api('POST', path, { token, idempotencyKey: key, body: { amount: 400_000 } });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await api('POST', path, { token, body: { amount: 300_000 } });
    expect(missing.status).toBe(400);

    expect(await db.payout.count({ where: { spaceId: space.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(700_000);
  });

  it('HTTP: refuses a rep who has not passed KYC', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const res = await api('POST', `/v1/spaces/${space.id}/payout/request`, {
      token: await tokenFor(rep),
      idempotencyKey: newKey(),
      body: { amount: 300_000 },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_NOT_VERIFIED');
  });
});

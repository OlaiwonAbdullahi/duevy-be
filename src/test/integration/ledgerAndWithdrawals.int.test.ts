import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { db } from '../../config/db';
import { ProviderError, type FakeProvider } from '../../providers/payment';
import { getSpaceBalance, getSpaceLedgerSummary } from '../../services/ledger.service';
import { completePayout, failPayoutByReference, requestWithdrawal } from '../../services/withdrawal.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { api, creditSpace, installFakeProvider, makeSpace, newKey, TEST_PIN, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

describe('ledger balance', () => {
  it('is derived from entries: collections − withdrawals − fees, restored by a reversal', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 3_000_000); // ₦30,000
    await creditSpace(space.id, 2_500_000); // ₦25,000
    expect(await getSpaceBalance(space.id)).toBe(5_500_000);

    // ₦20,000 withdrawal: ₦100 fee, ₦19,900 sent, ₦20,000 debited.
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 2_000_000, pin: TEST_PIN });
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
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 10_000_000); // ₦100,000
    fake.payoutDelayMs = 150; // hold the first in flight while the others arrive

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() => requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 6_000_000, pin: TEST_PIN })),
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
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    await expect(requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_000_001, pin: TEST_PIN })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 200_000, pin: TEST_PIN });
    await expect(requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 200_000, pin: TEST_PIN })).rejects.toMatchObject({
      code: 'WITHDRAWAL_IN_PROGRESS',
    });
    expect(await getSpaceBalance(space.id)).toBe(800_000);
  });

  it('a provider refusal fails the withdrawal and restores the balance', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    fake.failNextPayout = new ProviderError('Insufficient balance', 400, 'INSUFFICIENT_BALANCE', false);
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 500_000, pin: TEST_PIN });
    expect(p.status).toBe('failed');
    expect(p.failureReason).toMatch(/settling/);
    expect(await getSpaceBalance(space.id)).toBe(1_000_000);
    // The lock is released: a new withdrawal can start.
    const next = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 500_000, pin: TEST_PIN });
    expect(next.status).toBe('processing');
  });

  it('a timeout leaves the withdrawal pending (never assumed failed) for reconciliation to resend', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    fake.failNextPayout = new ProviderError('timeout', null, null, true);
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 500_000, pin: TEST_PIN });
    expect(p.status).toBe('pending');
    expect(await getSpaceBalance(space.id)).toBe(500_000); // still debited
  });

  it('payout webhooks: success settles; failure restores the balance; duplicates are no-ops', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 2_000_000);
    const a = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_000_000, pin: TEST_PIN });
    await sendWebhook({ id: `evt_pp_${a.reference}`, type: 'payout.paid', data: { withdrawal_id: a.providerPayoutId, reference: a.reference, status: 'completed' } });
    await sendWebhook({ id: `evt_pp_${a.reference}`, type: 'payout.paid', data: { withdrawal_id: a.providerPayoutId, reference: a.reference, status: 'completed' } });
    await drainWebhookQueue();
    expect((await db.payout.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('success');

    const b = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 500_000, pin: TEST_PIN });
    await sendWebhook({ id: `evt_pf_${b.reference}`, type: 'payout.failed', data: { withdrawal_id: b.providerPayoutId, reference: b.reference, status: 'failed' } });
    await drainWebhookQueue();
    expect((await db.payout.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('failed');
    expect(await getSpaceBalance(space.id)).toBe(1_000_000);
  });

  it('HTTP: the Idempotency-Key replays the first response and never creates a second withdrawal', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    const token = await tokenFor(rep);
    const key = newKey();
    const path = `/v1/spaces/${space.id}/payout/request`;

    const first = await api('POST', path, { token, idempotencyKey: key, body: { amount: 300_000, beneficiaryId: beneficiary!.id, pin: TEST_PIN } });
    expect(first.status).toBe(201);
    const replay = await api('POST', path, { token, idempotencyKey: key, body: { amount: 300_000, beneficiaryId: beneficiary!.id, pin: TEST_PIN } });
    expect(replay.status).toBe(201);
    expect(replay.body.data.reference).toBe(first.body.data.reference);
    const reused = await api('POST', path, { token, idempotencyKey: key, body: { amount: 400_000, beneficiaryId: beneficiary!.id, pin: TEST_PIN } });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await api('POST', path, { token, body: { amount: 300_000, beneficiaryId: beneficiary!.id, pin: TEST_PIN } });
    expect(missing.status).toBe(400);

    expect(await db.payout.count({ where: { spaceId: space.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(700_000);
  });

  it('HTTP: refuses a rep who has not passed KYC', async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const res = await api('POST', `/v1/spaces/${space.id}/payout/request`, {
      token: await tokenFor(rep),
      idempotencyKey: newKey(),
      body: { amount: 300_000, beneficiaryId: 'none', pin: TEST_PIN },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_NOT_VERIFIED');
  });
});

describe('beneficiaries', () => {
  it('HTTP: pays out to anyone added as a beneficiary, e.g. a lecturer, with no hold', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    const token = await tokenFor(rep);
    fake.resolvedName = 'ADEYEMI JOHN'; // not the rep's name

    const added = await api('POST', `/v1/spaces/${space.id}/payout/beneficiaries`, {
      token,
      body: { bankCode: '058', accountNumber: '0987654321', label: 'Dr. Adeyemi' },
    });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ accountName: 'ADEYEMI JOHN', accountNumber: '•••• 4321', label: 'Dr. Adeyemi' });
    // Adding the same account again returns the existing beneficiary.
    const again = await api('POST', `/v1/spaces/${space.id}/payout/beneficiaries`, {
      token,
      body: { bankCode: '058', accountNumber: '0987654321' },
    });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(added.body.data.id);

    const res = await api('POST', `/v1/spaces/${space.id}/payout/request`, {
      token,
      idempotencyKey: newKey(),
      body: { amount: 300_000, beneficiaryId: added.body.data.id, pin: TEST_PIN },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'processing', accountName: 'ADEYEMI JOHN', beneficiaryId: added.body.data.id });
    const registered = fake.calls.find((c) => c.op === 'registerPayoutDestination');
    const sent = fake.calls.find((c) => c.op === 'initiatePayout')?.args as { destinationId: string };
    expect(registered).toBeDefined();
    const payout = await db.payout.findUniqueOrThrow({ where: { reference: res.body.data.reference } });
    expect(sent.destinationId).toBe(payout.destinationId);

    // Removing it doesn't touch the withdrawal already made, but blocks new ones.
    const removed = await api('DELETE', `/v1/spaces/${space.id}/payout/beneficiaries/${added.body.data.id}`, { token });
    expect(removed.status).toBe(200);
    expect((await db.payout.findUniqueOrThrow({ where: { id: payout.id } })).destinationId).toBe(sent.destinationId);
    await completePayout(payout.reference);
    await expect(
      requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: added.body.data.id, amountKobo: 200_000, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'BENEFICIARY_NOT_FOUND' });
  });

  it('HTTP: sends to a one-off account without saving it as a beneficiary', async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    const token = await tokenFor(rep);
    fake.resolvedName = 'BELLO PRINTS LTD';
    const path = `/v1/spaces/${space.id}/payout/request`;

    const res = await api('POST', path, {
      token,
      idempotencyKey: newKey(),
      body: { amount: 300_000, bankCode: '058', accountNumber: '0555555555', pin: TEST_PIN },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'processing', accountName: 'BELLO PRINTS LTD', beneficiaryId: null });
    const payout = await db.payout.findUniqueOrThrow({ where: { reference: res.body.data.reference } });
    const sent = fake.calls.find((c) => c.op === 'initiatePayout')?.args as { destinationId: string };
    expect(sent.destinationId).toBe(payout.destinationId);
    expect(await db.payoutBeneficiary.count({ where: { spaceId: space.id, accountName: 'BELLO PRINTS LTD' } })).toBe(0);

    // Exactly one of beneficiaryId or bankCode + accountNumber.
    const neither = await api('POST', path, { token, idempotencyKey: newKey(), body: { amount: 300_000, pin: TEST_PIN } });
    expect(neither.status).toBe(400);
    const half = await api('POST', path, { token, idempotencyKey: newKey(), body: { amount: 300_000, bankCode: '058', pin: TEST_PIN } });
    expect(half.status).toBe(400);
  });

  it('requires the admin-set security code, and locks after 5 wrong tries', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    const req = (pin: string) => requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 200_000, pin });

    for (let i = 0; i < 4; i++) await expect(req('1111')).rejects.toMatchObject({ code: 'INVALID_WITHDRAWAL_PIN' });
    await expect(req('1111')).rejects.toMatchObject({ code: 'WITHDRAWAL_PIN_LOCKED' });
    // Locked: even the right code is refused, and nothing was debited.
    await expect(req(TEST_PIN)).rejects.toMatchObject({ code: 'WITHDRAWAL_PIN_LOCKED' });
    expect(await getSpaceBalance(space.id)).toBe(1_000_000);

    await db.space.update({ where: { id: space.id }, data: { withdrawalPinLockedUntil: null } });
    expect((await req(TEST_PIN)).status).toBe('processing');
  });

  it('lets the lead rep set, change and reset their own code (password required)', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    await db.space.update({ where: { id: space.id }, data: { withdrawalPinHash: null } });
    await db.user.update({ where: { id: rep.id }, data: { passwordHash: bcrypt.hashSync('Secret123!', 4) } });
    const token = await tokenFor(rep);
    const pinPath = `/v1/spaces/${space.id}/payout/pin`;

    // First code: password checked, weak codes refused.
    expect((await api('PUT', pinPath, { token, body: { pin: '4826', password: 'wrong' } })).status).toBe(403);
    expect((await api('PUT', pinPath, { token, body: { pin: '1234', password: 'Secret123!' } })).status).toBe(422);
    const set = await api('PUT', pinPath, { token, body: { pin: '4826', password: 'Secret123!' } });
    expect(set.status).toBe(200);
    expect(set.body.data.change).toBe('set');

    // Changing needs the current code.
    expect((await api('PUT', pinPath, { token, body: { pin: '7319', password: 'Secret123!' } })).status).toBe(400);
    expect((await api('PUT', pinPath, { token, body: { pin: '7319', password: 'Secret123!', currentPin: '0000' } })).status).toBe(403);
    const changed = await api('PUT', pinPath, { token, body: { pin: '7319', password: 'Secret123!', currentPin: '4826' } });
    expect(changed.body.data.change).toBe('changed');
    const req = (pin: string) => requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 200_000, pin });
    await expect(req('4826')).rejects.toMatchObject({ code: 'INVALID_WITHDRAWAL_PIN' });

    // Forgot it: reset with the password alone, then a 24h hold.
    const reset = await api('POST', `${pinPath}/reset`, { token, body: { pin: '5072', password: 'Secret123!' } });
    expect(reset.body.data.change).toBe('reset');
    await expect(req('5072')).rejects.toMatchObject({ code: 'WITHDRAWAL_PIN_HOLD' });
    await db.space.update({ where: { id: space.id }, data: { withdrawalPinHoldUntil: null } });
    expect((await req('5072')).status).toBe('processing');
  });

  it('clears the code when the lead rep changes', async () => {
    const { rep, space } = await makeSpace();
    const other = await db.user.create({ data: { name: 'Bayo', email: `b_${space.id}@test.duevy`, passwordHash: bcrypt.hashSync('Secret123!', 4) } });
    await db.spaceRep.create({ data: { userId: other.id, spaceId: space.id, role: 'co' } });
    await db.user.update({ where: { id: rep.id }, data: { passwordHash: bcrypt.hashSync('Secret123!', 4) } });
    const res = await api('POST', `/v1/spaces/${space.id}/transfer-lead`, {
      token: await tokenFor(rep),
      body: { userId: other.id, password: 'Secret123!' },
    });
    expect(res.status).toBeLessThan(300);
    expect((await db.space.findUniqueOrThrow({ where: { id: space.id } })).withdrawalPinHash).toBeNull();
  });

  it('refuses withdrawals until the lead rep sets a security code', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    await db.space.update({ where: { id: space.id }, data: { withdrawalPinHash: null } });
    await expect(
      requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 200_000, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'WITHDRAWAL_PIN_NOT_SET' });
  });

  it("refuses another space's beneficiary", async () => {
    const a = await makeSpace();
    const b = await makeSpace();
    await creditSpace(a.space.id, 1_000_000);
    await expect(
      requestWithdrawal({ spaceId: a.space.id, userId: a.rep.id, beneficiaryId: b.beneficiary!.id, amountKobo: 200_000, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'BENEFICIARY_NOT_FOUND' });
  });

  it('re-registers the destination on the current lead account after a lead change', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 1_000_000);
    await db.user.update({ where: { id: rep.id }, data: { bachsAccountId: `${rep.bachsAccountId}_new` } });
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 200_000, pin: TEST_PIN });
    expect(p.status).toBe('processing');
    expect(fake.calls.find((c) => c.op === 'registerPayoutDestination')?.args).toMatchObject({ accountId: `${rep.bachsAccountId}_new` });
    const updated = await db.payoutBeneficiary.findUniqueOrThrow({ where: { id: beneficiary!.id } });
    expect(updated.bachsAccountId).toBe(`${rep.bachsAccountId}_new`);
    expect(p.destinationId).toBe(updated.bachsDestinationId);
  });
});

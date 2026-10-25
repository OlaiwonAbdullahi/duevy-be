import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { db } from '../../config/db';
import { appendLedgerEntry, getDueAvailability, getSpaceBalance } from '../../services/ledger.service';
import { completePayout, requestWithdrawal } from '../../services/withdrawal.service';
import { expireStaleApprovals } from '../../services/withdrawalApproval.service';
import { api, creditSpace, installPaymentDouble, makeSpace, newKey, TEST_PIN, startHttp, stopHttp, tokenFor } from './fixtures';

// Capture approval codes instead of emailing them.
const codes = new Map<string, string>();
vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendWithdrawalOtpEmail: vi.fn(async (to: string, _name: string, w: { code: string }) => {
    codes.set(to, w.code);
  }),
}));

const PASSWORD = 'Secret123!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

let fake: ReturnType<typeof installPaymentDouble>;
beforeAll(async () => {
  fake = installPaymentDouble();
  await startHttp();
});
beforeEach(() => {
  fake.reset();
  codes.clear();
});
afterAll(stopHttp);

let seq = 0;
/** A verified member of the space (not yet a rep). */
async function member(spaceId: string, name: string) {
  const u = await db.user.create({
    data: { name, email: `${name.toLowerCase()}_${spaceId}_${++seq}@test.duevy`, passwordHash: PASSWORD_HASH, kycStatus: 'verified' },
  });
  await db.spaceMembership.create({ data: { userId: u.id, spaceId } });
  return u;
}

const dueLeft = async (spaceId: string, dueId: string) => (await getDueAvailability(spaceId)).get(dueId);

/** Money collected for one due. */
async function creditDue(spaceId: string, dueId: string, amountKobo: number) {
  await db.$transaction((tx) =>
    appendLedgerEntry(tx, { spaceId, dueId, type: 'manual_credit', direction: 'credit', amountKobo, reference: `TEST-${dueId}-${++seq}`, description: 'test' }),
  );
}

/** A space with a lead, two co-reps added through the API, and a password on the lead. */
async function team() {
  const s = await makeSpace();
  await db.user.update({ where: { id: s.rep.id }, data: { passwordHash: PASSWORD_HASH } });
  const leadToken = await tokenFor(s.rep);
  const base = `/v1/spaces/${s.space.id}`;
  const bola = await member(s.space.id, 'Bola');
  const chidi = await member(s.space.id, 'Chidi');
  for (const u of [bola, chidi]) {
    expect((await api('POST', `${base}/reps`, { token: leadToken, body: { userId: u.id } })).status).toBe(201);
  }
  return { ...s, lead: s.rep, leadToken, base, bola, chidi };
}

async function turnOnMultisig(t: Awaited<ReturnType<typeof team>>) {
  expect((await api('PUT', `${t.base}/payout/signatories`, { token: t.leadToken, body: { userIds: [t.bola.id, t.chidi.id], password: PASSWORD } })).status).toBe(200);
  expect((await api('PUT', `${t.base}/payout/security`, { token: t.leadToken, body: { mode: 'multisig', password: PASSWORD } })).status).toBe(200);
}

async function sign(base: string, payoutId: string, user: { id: string; email: string; role: string }) {
  const token = await tokenFor(user);
  if (!codes.has(user.email)) expect((await api('POST', `${base}/payout/${payoutId}/otp`, { token })).status).toBe(200);
  return api('POST', `${base}/payout/${payoutId}/approve`, { token, body: { otp: codes.get(user.email) } });
}

describe('team management', () => {
  it('the lead adds members as co-reps; non-members, duplicates and co-reps are refused', async () => {
    const t = await team();
    const reps = await api('GET', `${t.base}/reps`, { token: t.leadToken });
    expect(reps.body.data.map((r: { name: string; role: string }) => [r.name, r.role])).toEqual([
      ['Ada Obi', 'lead'],
      ['Bola', 'co'],
      ['Chidi', 'co'],
    ]);
    expect((await db.user.findUniqueOrThrow({ where: { id: t.bola.id } })).isRep).toBe(true);

    const outsider = await db.user.create({ data: { name: 'Out', email: `out_${t.space.id}@test.duevy` } });
    expect((await api('POST', `${t.base}/reps`, { token: t.leadToken, body: { userId: outsider.id } })).status).toBe(404);
    expect((await api('POST', `${t.base}/reps`, { token: t.leadToken, body: { userId: t.bola.id } })).status).toBe(409);
    const dayo = await member(t.space.id, 'Dayo');
    const asCo = await api('POST', `${t.base}/reps`, { token: await tokenFor(t.bola), body: { userId: dayo.id } });
    expect(asCo.status).toBe(403);
  });

  it('the lead can assign a new due to a co-rep; a co-rep can only take it themselves', async () => {
    const t = await team();
    const body = (extra: Record<string, unknown>) => ({
      title: 'Lab coat fee',
      amount: 500_000,
      dueDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
      category: 'departmental_due',
      ...extra,
    });
    const created = await api('POST', `${t.base}/dues`, { token: t.leadToken, body: body({ assignedRepId: t.bola.id }) });
    expect(created.status).toBe(201);
    expect(created.body.data.assignedRepId).toBe(t.bola.id);

    const outsider = await member(t.space.id, 'Dayo');
    expect((await api('POST', `${t.base}/dues`, { token: t.leadToken, body: body({ assignedRepId: outsider.id }) })).status).toBe(400);
    const bolaToken = await tokenFor(t.bola);
    expect((await api('POST', `${t.base}/dues`, { token: bolaToken, body: body({ assignedRepId: t.chidi.id }) })).status).toBe(403);
    const own = await api('POST', `${t.base}/dues`, { token: bolaToken, body: body({}) });
    expect(own.body.data.assignedRepId).toBe(t.bola.id);
  });

  it('a co-rep withdraws only from a due assigned to them, capped at what it collected, out of the lead account', async () => {
    const t = await team();
    const [due] = t.dues;
    await creditDue(t.space.id, due!.id, 500_000);
    await creditSpace(t.space.id, 2_000_000); // other money in the space
    const req = (extra: { dueId?: string; amountKobo?: number }) =>
      requestWithdrawal({ spaceId: t.space.id, userId: t.bola.id, beneficiaryId: t.beneficiary!.id, amountKobo: 300_000, pin: TEST_PIN, ...extra });

    await expect(req({})).rejects.toMatchObject({ code: 'DUE_REQUIRED' });
    await expect(req({ dueId: due!.id })).rejects.toMatchObject({ code: 'DUE_NOT_ASSIGNED' });

    const assign = await api('POST', `${t.base}/dues/${due!.id}/reassign`, { token: t.leadToken, body: { userId: t.bola.id } });
    expect(assign.status).toBe(200);
    await expect(req({ dueId: due!.id, amountKobo: 600_000 })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

    const p = await req({ dueId: due!.id });
    expect(p).toMatchObject({ status: 'processing', dueId: due!.id, requestedById: t.bola.id, providerAccountId: t.lead.walletAccountNumber });
    expect(await dueLeft(t.space.id, due!.id)).toBe(200_000);
    expect(await getSpaceBalance(t.space.id)).toBe(2_200_000);

    // Chidi isn't assigned it.
    await expect(
      requestWithdrawal({ spaceId: t.space.id, userId: t.chidi.id, dueId: due!.id, beneficiaryId: t.beneficiary!.id, amountKobo: 100_000, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'DUE_NOT_ASSIGNED' });

    // Removing the rep ends their assignment.
    await api('DELETE', `${t.base}/reps/${t.bola.id}`, { token: t.leadToken });
    expect((await db.due.findUniqueOrThrow({ where: { id: due!.id } })).assignedRepId).toBeNull();
  });
});

describe('what is left of each due', () => {
  it('whole-balance withdrawals use up the dues, so they never show more than the balance', async () => {
    const { rep, space, dues, beneficiary } = await makeSpace();
    await creditDue(space.id, dues[0]!.id, 1_200_000); // ₦12,000 collected
    await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_140_000, pin: TEST_PIN });
    expect(await getSpaceBalance(space.id)).toBe(60_000);
    expect(await dueLeft(space.id, dues[0]!.id)).toBe(60_000);
    const listed = await api('GET', `/v1/spaces/${space.id}/payout/dues`, { token: await tokenFor(rep) });
    expect(listed.body.data[0].available).toBe(60_000);
  });

  it("takes from the lead's dues before a co-rep's", async () => {
    const t = await team();
    const [leadDue, bolaDue] = await Promise.all(
      ['Lead due', 'Bola due'].map((title) =>
        db.due.create({ data: { spaceId: t.space.id, title, amount: 500_000, dueDate: new Date(Date.now() + 7 * 864e5), category: 'departmental_due', status: 'active' } }),
      ),
    );
    await api('POST', `${t.base}/dues/${bolaDue!.id}/reassign`, { token: t.leadToken, body: { userId: t.bola.id } });
    await creditDue(t.space.id, leadDue!.id, 500_000);
    await creditDue(t.space.id, bolaDue!.id, 500_000);

    const whole = await requestWithdrawal({ spaceId: t.space.id, userId: t.lead.id, beneficiaryId: t.beneficiary!.id, amountKobo: 600_000, pin: TEST_PIN });
    await completePayout(whole.reference);
    expect(await dueLeft(t.space.id, leadDue!.id)).toBe(0);
    // ₦6,000 sent, then Bank78's ₦50 fee — both after the lead's due runs out.
    expect(await dueLeft(t.space.id, bolaDue!.id)).toBe(395_000);
    await expect(
      requestWithdrawal({ spaceId: t.space.id, userId: t.bola.id, dueId: bolaDue!.id, beneficiaryId: t.beneficiary!.id, amountKobo: 450_000, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
});

describe('signatory approval (multisig)', () => {
  it('needs 3 signatories to turn on; a withdrawal waits for 2 signed codes, then pays', async () => {
    const t = await team();
    await creditSpace(t.space.id, 1_000_000);
    const security = (mode: string) => api('PUT', `${t.base}/payout/security`, { token: t.leadToken, body: { mode, password: PASSWORD } });
    expect((await security('multisig')).body.error.code).toBe('SIGNATORIES_INCOMPLETE');
    expect((await api('PUT', `${t.base}/payout/signatories`, { token: await tokenFor(t.bola), body: { userIds: [t.bola.id], password: PASSWORD } })).status).toBe(403);
    await turnOnMultisig(t);
    const summary = await api('GET', `${t.base}/payout/summary`, { token: t.leadToken });
    expect(summary.body.data).toMatchObject({ withdrawalAuthMode: 'multisig', signatoriesComplete: true });

    // No security code needed: the lead's own code is emailed straight away.
    const created = await api('POST', `${t.base}/payout/request`, {
      token: t.leadToken,
      idempotencyKey: newKey(),
      body: { amount: 400_000, beneficiaryId: t.beneficiary!.id },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'awaiting_approval', approval: { required: 2, approvedCount: 0, otpSentToRequester: true } });
    const id = created.body.data.id as string;
    // Funds are reserved, and nothing has gone to the bank.
    expect(await getSpaceBalance(t.space.id)).toBe(600_000);
    expect(fake.calls.filter((c) => c.op === 'initiatePayout')).toHaveLength(0);

    const wrong = await api('POST', `${t.base}/payout/${id}/approve`, { token: t.leadToken, body: { otp: codes.get(t.lead.email) === '000000' ? '111111' : '000000' } });
    expect(wrong.body.error.code).toBe('INVALID_OTP');

    const first = await sign(t.base, id, t.lead);
    expect(first.body.data).toMatchObject({ status: 'awaiting_approval', approval: { approvedCount: 1 } });
    expect((await sign(t.base, id, t.lead)).body.error.code).toBe('ALREADY_SIGNED');
    // A co-rep who isn't a signatory can't sign.
    const dayo = await member(t.space.id, 'Dayo');
    await api('POST', `${t.base}/reps`, { token: t.leadToken, body: { userId: dayo.id } });
    expect((await api('POST', `${t.base}/payout/${id}/otp`, { token: await tokenFor(dayo) })).body.error.code).toBe('NOT_A_SIGNATORY');

    const second = await sign(t.base, id, t.chidi);
    expect(second.body.data.status).toBe('processing');
    expect(fake.calls.filter((c) => c.op === 'initiatePayout')).toHaveLength(1);
  });

  it('a co-rep who is not a signatory needs two signatures; a rejection cancels and restores the due', async () => {
    const t = await team();
    const [due] = t.dues;
    await creditDue(t.space.id, due!.id, 800_000);
    const dayo = await member(t.space.id, 'Dayo');
    await api('POST', `${t.base}/reps`, { token: t.leadToken, body: { userId: dayo.id } });
    await api('POST', `${t.base}/dues/${due!.id}/reassign`, { token: t.leadToken, body: { userId: dayo.id } });
    await turnOnMultisig(t);

    const p = await requestWithdrawal({ spaceId: t.space.id, userId: dayo.id, dueId: due!.id, beneficiaryId: t.beneficiary!.id, amountKobo: 500_000 });
    expect(p.status).toBe('awaiting_approval');
    expect(await dueLeft(t.space.id, due!.id)).toBe(300_000);

    expect((await sign(t.base, p.id, t.bola)).body.data.status).toBe('awaiting_approval');
    const rejected = await api('POST', `${t.base}/payout/${p.id}/reject`, { token: await tokenFor(t.chidi), body: { reason: 'not agreed' } });
    expect(rejected.body.data).toMatchObject({ status: 'cancelled' });
    expect(rejected.body.data.failureReason).toContain('rejected by Chidi');
    expect(await dueLeft(t.space.id, due!.id)).toBe(800_000);
    expect(await getSpaceBalance(t.space.id)).toBe(800_000);
    expect(fake.calls.filter((c) => c.op === 'initiatePayout')).toHaveLength(0);

    // The space is free for the next withdrawal; its requester can withdraw it themselves.
    const again = await requestWithdrawal({ spaceId: t.space.id, userId: dayo.id, dueId: due!.id, beneficiaryId: t.beneficiary!.id, amountKobo: 200_000 });
    const withdrawn = await api('POST', `${t.base}/payout/${again.id}/reject`, { token: await tokenFor(dayo), body: {} });
    expect(withdrawn.body.data.failureReason).toContain('withdrawn by Dayo');
  });

  it('expires unsigned withdrawals; wrong codes void the code', async () => {
    const t = await team();
    await creditSpace(t.space.id, 1_000_000);
    await turnOnMultisig(t);
    const p = await requestWithdrawal({ spaceId: t.space.id, userId: t.lead.id, beneficiaryId: t.beneficiary!.id, amountKobo: 300_000 });

    const bolaToken = await tokenFor(t.bola);
    await api('POST', `${t.base}/payout/${p.id}/otp`, { token: bolaToken });
    const bad = codes.get(t.bola.email) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      expect((await api('POST', `${t.base}/payout/${p.id}/approve`, { token: bolaToken, body: { otp: bad } })).body.error.code).toBe('INVALID_OTP');
    }
    expect((await api('POST', `${t.base}/payout/${p.id}/approve`, { token: bolaToken, body: { otp: bad } })).body.error.code).toBe('OTP_LOCKED');
    expect((await api('POST', `${t.base}/payout/${p.id}/approve`, { token: bolaToken, body: { otp: codes.get(t.bola.email) } })).body.error.code).toBe('OTP_EXPIRED');

    await db.payout.update({ where: { id: p.id }, data: { approvalExpiresAt: new Date(Date.now() - 1000) } });
    await expireStaleApprovals();
    expect((await db.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('cancelled');
    expect(await getSpaceBalance(t.space.id)).toBe(1_000_000);
  });

  it('holds withdrawals 24h after a signatory change or switching approvals off; a lead transfer keeps 3 signatories', async () => {
    const t = await team();
    await creditSpace(t.space.id, 1_000_000);
    await turnOnMultisig(t);
    const dayo = await member(t.space.id, 'Dayo');
    await api('POST', `${t.base}/reps`, { token: t.leadToken, body: { userId: dayo.id } });

    // Approvals on: can't drop below two co-rep signatories, and a swap starts a hold.
    const drop = await api('PUT', `${t.base}/payout/signatories`, { token: t.leadToken, body: { userIds: [t.bola.id], password: PASSWORD } });
    expect(drop.body.error.code).toBe('SIGNATORIES_INCOMPLETE');
    const swap = await api('PUT', `${t.base}/payout/signatories`, { token: t.leadToken, body: { userIds: [t.bola.id, dayo.id], password: PASSWORD } });
    expect(swap.body.data.withdrawalPinHoldUntil).toBeTruthy();
    const req = () => requestWithdrawal({ spaceId: t.space.id, userId: t.lead.id, beneficiaryId: t.beneficiary!.id, amountKobo: 200_000, pin: TEST_PIN });
    await expect(req()).rejects.toMatchObject({ code: 'WITHDRAWAL_PIN_HOLD' });
    await db.space.update({ where: { id: t.space.id }, data: { withdrawalPinHoldUntil: null } });

    // Lead handover: Bola becomes lead, Ada takes Bola's signatory seat.
    const waiting = await req();
    expect(waiting.status).toBe('awaiting_approval');
    const transfer = await api('POST', `${t.base}/transfer-lead`, { token: t.leadToken, body: { userId: t.bola.id, password: PASSWORD } });
    expect(transfer.status).toBeLessThan(300);
    expect((await db.payout.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('cancelled');
    const reps = (await api('GET', `${t.base}/reps`, { token: await tokenFor(t.bola) })).body.data as { name: string; isSignatory: boolean }[];
    expect(reps.filter((r) => r.isSignatory).map((r) => r.name).sort()).toEqual(['Ada Obi', 'Bola', 'Dayo']);

    // Switching approvals off holds withdrawals too.
    const off = await api('PUT', `${t.base}/payout/security`, { token: await tokenFor(t.bola), body: { mode: 'pin', password: PASSWORD } });
    expect(off.body.data).toMatchObject({ withdrawalAuthMode: 'pin', changed: true });
    expect(off.body.data.withdrawalPinHoldUntil).toBeTruthy();
  });
});

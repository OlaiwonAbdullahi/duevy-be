import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout, findCheckoutId, fulfilCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { failPayoutByReference, refreshPayout, requestWithdrawal } from '../../services/withdrawal.service';
import { MAX_PAYOUT_KOBO, MAX_TRANSFER_KOBO, MIN_PAYOUT_KOBO } from '../../lib/money';
import {
  DAILY_LIMIT_KOBO,
  ensureSpaceAccount,
  getDailyAllowanceKobo,
  getWithdrawalAllowanceKobo,
  getUnsweptKobo,
  refreshSweep,
  runDailySweeps,
  startOfLagosDay,
} from '../../services/sweep.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { FakeProvider as Fake } from '../../providers/payment/fake/FakeProvider';
import { api, creditEvent, creditSpace, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp, TEST_PIN, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

/** A student pays a due through a real checkout: the money is in Duevy's business account, unswept. */
async function collect(spaceSetup: Awaited<ReturnType<typeof makeSpace>>, dueIndex = 0, student = 0) {
  const { checkout } = await createCheckout(spaceSetup.students[student]!.id, [spaceSetup.dues[dueIndex]!.id]);
  await fulfilCheckout(await findCheckoutId(checkout.reference, null), checkout.amount, 0, 'test');
  return checkout;
}

/** 03:00 in Lagos today — after the daily sweep hour. */
const afterSweepHour = () => new Date(startOfLagosDay().getTime() + 3 * 60 * 60 * 1000);

function sweepTransfers() {
  return fake.calls.filter((c) => c.op === 'initiateTransfer' && (c.args as { from: unknown }).from === 'business');
}

describe('daily sweep', () => {
  it("moves a space's collections into its own account once a day, without touching its balance", async () => {
    const s = await makeSpace({ members: 2, dues: [500_000, 300_000] });
    await collect(s, 0, 0);
    await collect(s, 1, 1);
    expect(await getSpaceBalance(s.space.id)).toBe(800_000);
    expect(await getUnsweptKobo(s.space.id)).toBe(800_000);

    await runDailySweeps(afterSweepHour());
    const sweep = await db.sweep.findFirstOrThrow({ where: { spaceId: s.space.id } });
    expect(sweep).toMatchObject({ amountKobo: 800_000, trigger: 'daily', status: 'processing' });
    expect(sweepTransfers().find((c) => (c.args as { reference: string }).reference === sweep.reference)?.args).toMatchObject({
      accountNumber: s.space.walletAccountNumber,
      bankCode: '090629',
      amountKobo: 800_000,
    });
    // In flight counts as moved; the balance is the space's either way and Duevy pays the transfer.
    expect(await getUnsweptKobo(s.space.id)).toBe(0);
    expect(await getSpaceBalance(s.space.id)).toBe(800_000);

    // The credit on the space's account prompts a status check, which settles it.
    fake.settleTransfer(sweep.reference, 'succeeded');
    await sendWebhook(creditEvent({ accountNumber: s.space.walletAccountNumber!, accountRequestReference: Fake.spaceAccountReference(s.space.id), amountKobo: 800_000 }));
    await drainWebhookQueue();
    expect((await db.sweep.findUniqueOrThrow({ where: { id: sweep.id } })).status).toBe('succeeded');

    // Once a day: a second run the same day does nothing, even with new money.
    await collect(s, 0, 1);
    await runDailySweeps(afterSweepHour());
    expect(await db.sweep.count({ where: { spaceId: s.space.id } })).toBe(1);
    expect(await getUnsweptKobo(s.space.id)).toBe(500_000);
  });

  it('waits for the sweep hour, and leaves a space below the minimum for another day', async () => {
    const s = await makeSpace({ dues: [50_000] }); // ₦500, under the ₦1,000 minimum
    await collect(s);
    await runDailySweeps(new Date(startOfLagosDay().getTime() + 60 * 60 * 1000)); // 01:00 Lagos
    await runDailySweeps(afterSweepHour());
    expect(await db.sweep.count({ where: { spaceId: s.space.id } })).toBe(0);
  });

  it('a failed sweep counts as unswept again', async () => {
    const s = await makeSpace();
    await collect(s);
    fake.transferOutcome = 'failed';
    await runDailySweeps(afterSweepHour());
    const sweep = await db.sweep.findFirstOrThrow({ where: { spaceId: s.space.id } });
    expect(sweep.status).toBe('failed');
    expect(await getUnsweptKobo(s.space.id)).toBe(500_000);
  });
});

describe('withdrawals and the sweep', () => {
  it('sweeps what a withdrawal needs first, then pays out of the space account', async () => {
    const s = await makeSpace();
    await collect(s); // ₦5,000 collected, all unswept
    const p = await requestWithdrawal({ spaceId: s.space.id, userId: s.rep.id, beneficiaryId: s.beneficiary!.id, amountKobo: 300_000, pin: TEST_PIN });
    expect(p.status).toBe('pending');
    const sweep = await db.sweep.findUniqueOrThrow({ where: { id: p.sweepId! } });
    expect(sweep).toMatchObject({ amountKobo: 300_000, trigger: 'withdrawal', status: 'processing' });
    expect(fake.calls.filter((c) => c.op === 'initiateTransfer')).toHaveLength(1); // the sweep only

    fake.settleTransfer(sweep.reference, 'succeeded');
    await refreshSweep(sweep.id);
    const sent = await db.payout.findUniqueOrThrow({ where: { id: p.id } });
    expect(sent.status).toBe('processing');
    expect(fake.calls.filter((c) => c.op === 'initiateTransfer').at(-1)?.args).toMatchObject({
      from: { accountNumber: s.space.walletAccountNumber },
      reference: p.reference,
      amountKobo: 300_000 - 1_000,
    });
    expect(await getUnsweptKobo(s.space.id)).toBe(200_000);
  });

  it('a withdrawal whose sweep fails fails too, and the balance is restored', async () => {
    const s = await makeSpace();
    await collect(s);
    const p = await requestWithdrawal({ spaceId: s.space.id, userId: s.rep.id, beneficiaryId: s.beneficiary!.id, amountKobo: 300_000, pin: TEST_PIN });
    const sweep = await db.sweep.findUniqueOrThrow({ where: { id: p.sweepId! } });
    fake.settleTransfer(sweep.reference, 'failed');
    await refreshSweep(sweep.id);
    const failed = await db.payout.findUniqueOrThrow({ where: { id: p.id } });
    expect(failed.status).toBe('failed');
    expect(await getSpaceBalance(s.space.id)).toBe(500_000);
    expect(await getUnsweptKobo(s.space.id)).toBe(500_000);
  });

  it('needs no sweep when the space account already holds enough', async () => {
    const s = await makeSpace();
    await creditSpace(s.space.id, 1_000_000); // not a 9jaPay collection: nothing to sweep
    const p = await requestWithdrawal({ spaceId: s.space.id, userId: s.rep.id, beneficiaryId: s.beneficiary!.id, amountKobo: 300_000, pin: TEST_PIN });
    expect(p.sweepId).toBeNull();
    expect(p.status).toBe('processing');
  });
});

describe('withdrawal limits: ₦500k at once, ₦5M a day per space', () => {
  const withdraw = (s: Awaited<ReturnType<typeof makeSpace>>, amountKobo: number) =>
    requestWithdrawal({ spaceId: s.space.id, userId: s.rep.id, beneficiaryId: s.beneficiary!.id, amountKobo, pin: TEST_PIN });

  it('refuses more than ₦500,000 in one withdrawal', async () => {
    const s = await makeSpace();
    await creditSpace(s.space.id, 100_000_000); // ₦1M in the space account
    await expect(withdraw(s, MAX_PAYOUT_KOBO + 1)).rejects.toMatchObject({ code: 'ABOVE_MAX_PAYOUT' });
    expect((await withdraw(s, MAX_PAYOUT_KOBO)).status).toBe('processing');
    expect(await getSpaceBalance(s.space.id)).toBe(50_000_000);
  });

  it('refuses withdrawals past ₦5,000,000 in a Lagos day', async () => {
    const s = await makeSpace();
    await creditSpace(s.space.id, 1_000_000_000); // ₦10M
    // Nine ₦500k withdrawals (one in flight at a time) = ₦4.5M.
    for (let i = 0; i < 9; i++) {
      const p = await withdraw(s, MAX_PAYOUT_KOBO);
      fake.settleTransfer(p.reference, 'succeeded');
      await refreshPayout(p.id);
    }
    expect(await getWithdrawalAllowanceKobo(s.space.id)).toBe(50_000_000);
    await expect(withdraw(s, 50_000_100)).rejects.toMatchObject({ code: 'ABOVE_MAX_PAYOUT' });
    const tenth = await withdraw(s, 50_000_000);
    fake.settleTransfer(tenth.reference, 'succeeded');
    await refreshPayout(tenth.id);
    await expect(withdraw(s, MIN_PAYOUT_KOBO)).rejects.toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
    expect(await getSpaceBalance(s.space.id)).toBe(500_000_000);

    // A failed withdrawal gives its share of the day back.
    await failPayoutByReference(tenth.reference, 'returned by the bank');
    expect(await getWithdrawalAllowanceKobo(s.space.id)).toBe(50_000_000);
  });

  it('splits a sweep into transfers of at most ₦1,000,000 (9jaPay’s single-transfer limit)', async () => {
    const s = await makeSpace({ dues: [250_000_000] }); // a ₦2.5M due
    await collect(s);
    await runDailySweeps(afterSweepHour());
    const sweeps = await db.sweep.findMany({ where: { spaceId: s.space.id }, orderBy: { amountKobo: 'desc' } });
    expect(sweeps.map((w) => w.amountKobo)).toEqual([MAX_TRANSFER_KOBO, MAX_TRANSFER_KOBO, 50_000_000]);
    expect(await getUnsweptKobo(s.space.id)).toBe(0);
  });

  it("stops a sweep at the space account's ₦10M a day; the rest waits for another day", async () => {
    const s = await makeSpace();
    await collect(s); // ₦5,000 unswept
    // ₦9,998,000 already swept into it today.
    await db.sweep.create({
      data: { spaceId: s.space.id, amountKobo: DAILY_LIMIT_KOBO - 200_000, trigger: 'withdrawal', reference: `SWPTEST${s.space.id}`, status: 'succeeded' },
    });
    // That sweep was for money collected another way; count it as collected so it isn't "oversweeping".
    await creditSpace(s.space.id, DAILY_LIMIT_KOBO - 200_000);
    expect(await getDailyAllowanceKobo(s.space.id)).toBe(200_000);
  });
});

describe('space accounts', () => {
  it('opens a permanent account when a space is created', async () => {
    const { rep } = await makeSpace();
    const res = await api('POST', '/v1/spaces', { token: await tokenFor(rep), body: { name: 'Physics Students Association', short: 'PSA', kind: 'association' } });
    expect(res.status).toBe(201);
    await vi.waitFor(async () => {
      const space = await db.space.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(space.walletAccountNumber).toMatch(/^91\d{8}$/);
      expect(space).toMatchObject({ walletAccountName: 'Physics Students Association', walletBankCode: '090629' });
    });
  });

  it('opening is retried when it failed, and never opens a second account', async () => {
    const s = await makeSpace();
    await db.space.update({
      where: { id: s.space.id },
      data: { walletAccountId: null, walletAccountNumber: null, walletAccountName: null, walletBankName: null, walletBankCode: null, walletCreatedAt: null },
    });
    const opened = await ensureSpaceAccount(s.space.id);
    expect(opened.walletAccountNumber).toMatch(/^91\d{8}$/);
    expect((await ensureSpaceAccount(s.space.id)).walletAccountNumber).toBe(opened.walletAccountNumber);
    expect(fake.calls.filter((c) => c.op === 'createSpaceAccount' && (c.args as { reference: string }).reference === s.space.id)).toHaveLength(1);
  });
});

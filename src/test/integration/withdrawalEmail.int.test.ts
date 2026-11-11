import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { buildWithdrawalUpdateEmail, sendWithdrawalUpdateEmail } from '../../lib/email';
import { completePayout, failPayoutByReference, requestWithdrawal } from '../../services/withdrawal.service';
import { creditSpace, installFakeProvider, makeSpace, startHttp, stopHttp, TEST_PIN } from './fixtures';

vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendWithdrawalUpdateEmail: vi.fn(async () => {}),
}));
const withdrawalEmail = vi.mocked(sendWithdrawalUpdateEmail);

beforeAll(async () => {
  installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);
beforeEach(() => {
  withdrawalEmail.mockReset().mockResolvedValue(undefined);
});

/** A space with its lead plus an active and a deactivated co-rep. */
async function spaceWithTeam() {
  const s = await makeSpace();
  const co = await db.user.create({ data: { name: 'Tunde Co', email: `co_${Date.now()}_${Math.random()}@test.duevy`, role: 'rep', isRep: true } });
  const gone = await db.user.create({ data: { name: 'Gone Rep', email: `gone_${Date.now()}_${Math.random()}@test.duevy`, role: 'rep', isRep: true, isDeactivated: true } });
  await db.spaceRep.createMany({ data: [{ userId: co.id, spaceId: s.space.id, role: 'co' }, { userId: gone.id, spaceId: s.space.id, role: 'co' }] });
  await creditSpace(s.space.id, 3_000_000);
  return { ...s, co, gone };
}

describe('withdrawal emails', () => {
  it('emails every active rep when a withdrawal completes, "you" to the rep who made it', async () => {
    const { rep, co, gone, space, beneficiary } = await spaceWithTeam();
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 2_000_000, pin: TEST_PIN });
    expect(withdrawalEmail).not.toHaveBeenCalled(); // not until it has an outcome

    await completePayout(p.reference);
    const sent = withdrawalEmail.mock.calls;
    expect(sent.map((c) => c[0]).sort()).toEqual([rep.email, co.email].sort());
    expect(sent.map((c) => c[0])).not.toContain(gone.email);
    const toLead = sent.find((c) => c[0] === rep.email)![2];
    const toCo = sent.find((c) => c[0] === co.email)![2];
    expect(toLead).toMatchObject({
      outcome: 'success', spaceName: space.name, netKobo: 1_998_387, feeKobo: 1_613, grossKobo: 2_000_000,
      destination: 'ADA OBI · Guaranty Trust Bank •••• 6789', requestedBy: 'Ada Obi', viewerIsRequester: true, reference: p.reference,
    });
    expect(toCo).toMatchObject({ outcome: 'success', viewerIsRequester: false });

    // Reported twice (webhook and reconciliation): emailed once.
    await completePayout(p.reference);
    expect(withdrawalEmail).toHaveBeenCalledTimes(2);
  });

  it('emails a failure, and a later bank reversal, with the reason', async () => {
    const { rep, space, beneficiary } = await spaceWithTeam();
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_000_000, pin: TEST_PIN });
    await failPayoutByReference(p.reference, 'Beneficiary account is dormant');
    expect(withdrawalEmail.mock.calls.find((c) => c[0] === rep.email)![2]).toMatchObject({ outcome: 'failed', reason: 'Beneficiary account is dormant' });

    const q = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_000_000, pin: TEST_PIN });
    await completePayout(q.reference);
    withdrawalEmail.mockClear();
    await failPayoutByReference(q.reference, 'returned by the bank');
    expect(withdrawalEmail.mock.calls.find((c) => c[0] === rep.email)![2]).toMatchObject({ outcome: 'reversed' });
  });

  it('a failed email never fails the withdrawal', async () => {
    const { rep, space, beneficiary } = await spaceWithTeam();
    withdrawalEmail.mockRejectedValue(new Error('SMTP down'));
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_000_000, pin: TEST_PIN });
    await expect(completePayout(p.reference)).resolves.toBe(true);
    expect((await db.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('success');
  });

  it('reads right and escapes names', () => {
    const base = {
      spaceName: 'Computer <Science>', netKobo: 1_998_387, feeKobo: 1_613, grossKobo: 2_000_000, destination: 'ADA OBI · GTBank •••• 6789',
      dueTitle: 'Dept dues', requestedBy: 'Ada <b>Obi</b>', reference: 'WD-2026-ABC', reason: null, at: new Date('2026-11-11T10:00:00Z'), link: 'https://duevy.app/dashboard/payout',
    };
    const mine = buildWithdrawalUpdateEmail('Ada Obi', { ...base, outcome: 'success', viewerIsRequester: true });
    expect(mine.subject).toBe('You sent ₦19,983.87 from Computer <Science>');
    expect(mine.text).toContain('You sent ₦19,983.87 from Computer <Science> to ADA OBI · GTBank •••• 6789.');
    expect(mine.text).toContain('Total from balance: ₦20,000.00');
    expect(mine.html).not.toContain('<Science>');
    const theirs = buildWithdrawalUpdateEmail('Tunde Co', { ...base, outcome: 'success', viewerIsRequester: false });
    expect(theirs.html).not.toContain('<b>Obi</b>');
    expect(theirs.html).toContain('Ada &lt;b&gt;Obi&lt;/b&gt; sent');
    const failed = buildWithdrawalUpdateEmail('Ada Obi', { ...base, outcome: 'failed', viewerIsRequester: true, reason: 'Dormant account' });
    expect(failed.subject).toBe('Withdrawal failed — ₦19,983.87 from Computer <Science>');
    expect(failed.text).toContain('Reason: Dormant account');
    expect(failed.text).toContain('is back in the space balance');
  });
});

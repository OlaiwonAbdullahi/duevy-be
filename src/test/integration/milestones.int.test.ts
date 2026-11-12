import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { buildTransactionMilestoneEmail, milestoneLabel, sendTransactionMilestoneEmail } from '../../lib/email';
import { checkPaymentMilestone, highestMilestone } from '../../services/milestones.service';
import { makeSpace } from './fixtures';

vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendTransactionMilestoneEmail: vi.fn(async () => {}),
}));
const milestoneEmail = vi.mocked(sendTransactionMilestoneEmail);
const KEY = 'milestones.payments';

beforeEach(() => {
  milestoneEmail.mockReset().mockResolvedValue(undefined);
});

/** Pretend the last milestone emailed is the one just below where payments now stand. */
async function armJustBelow(): Promise<number> {
  const count = await db.checkout.count({ where: { status: 'paid' } });
  const { space, students } = await makeSpace();
  // Enough paid payments to stand at a milestone of 100 or more.
  const need = Math.max(0, 100 - count);
  if (need) {
    await db.checkout.createMany({
      data: Array.from({ length: need }, (_, i) => ({
        reference: `MLS${Date.now()}${i}${Math.random().toString(36).slice(2, 6)}`,
        userId: students[0]!.id, spaceId: space.id, faceKobo: 100_000, feeKobo: 1_500, totalKobo: 101_500,
        dueSetKey: `mls-${i}`, expiresAt: new Date(), status: 'paid', paidAt: new Date(),
      })),
    });
  }
  const reached = highestMilestone(await db.checkout.count({ where: { status: 'paid' } }))!;
  await db.platformSetting.upsert({
    where: { key: KEY },
    update: { value: { milestone: reached - 1, at: '2026-11-01T00:00:00.000Z' } },
    create: { key: KEY, value: { milestone: reached - 1, at: '2026-11-01T00:00:00.000Z' } },
  });
  return reached;
}

describe('payments milestone emails', () => {
  it('picks milestones: fixed steps, then every million', () => {
    expect([99, 100, 999, 1_000, 2_499, 2_500, 1_999_999, 2_000_000, 3_400_000].map(highestMilestone)).toEqual([
      null, 100, 500, 1_000, 1_000, 2_500, 1_000_000, 2_000_000, 3_000_000,
    ]);
    expect([100, 1_000, 2_500, 10_000, 1_000_000].map(milestoneLabel)).toEqual(['100', '1k', '2.5k', '10k', '1m']);
  });

  it('emails every active admin once, with the key numbers', async () => {
    const reached = await armJustBelow();
    const admin = await db.user.create({ data: { name: 'Ada Admin', email: `adm_${Date.now()}@test.duevy`, role: 'admin' } });
    const gone = await db.user.create({ data: { name: 'Old Admin', email: `old_${Date.now()}@test.duevy`, role: 'admin', isDeactivated: true } });

    expect(await checkPaymentMilestone()).toBe(reached);
    const to = milestoneEmail.mock.calls.map((c) => c[0]);
    expect(to).toContain(admin.email);
    expect(to).not.toContain(gone.email);
    const figures = milestoneEmail.mock.calls[0]![2];
    const paid = await db.checkout.aggregate({ where: { status: 'paid' }, _count: { _all: true }, _sum: { faceKobo: true, totalKobo: true, feeKobo: true } });
    expect(figures).toMatchObject({
      milestone: reached,
      payments: paid._count._all,
      netKobo: paid._sum.faceKobo,
      volumeKobo: paid._sum.totalKobo,
      feesKobo: paid._sum.feeKobo,
      previous: { milestone: reached - 1 },
    });

    // Already sent: a second check (or a second worker) sends nothing.
    milestoneEmail.mockClear();
    const [a, b] = await Promise.all([checkPaymentMilestone(), checkPaymentMilestone()]);
    expect([a, b]).toEqual([null, null]);
    expect(milestoneEmail).not.toHaveBeenCalled();
  });

  it('two workers checking at once send it once', async () => {
    const reached = await armJustBelow();
    const results = await Promise.all([checkPaymentMilestone(), checkPaymentMilestone(), checkPaymentMilestone()]);
    expect(results.filter((r) => r === reached)).toHaveLength(1);
  });

  it('reads right', () => {
    const m = {
      milestone: 1_000, payments: 1_004, volumeKobo: 507_500_000, netKobo: 500_000_000, feesKobo: 7_500_000,
      payouts: 42, paidOutKobo: 380_000_000, spaces: 31, reps: 40, students: 2_100, campuses: 1,
      firstPaymentAt: new Date('2026-09-01T00:00:00Z'), previous: { milestone: 500, at: new Date('2026-10-20T00:00:00Z') },
      at: new Date('2026-11-12T00:00:00Z'), link: 'https://duevy.app/admin/overview',
    };
    const email = buildTransactionMilestoneEmail('Ada Admin', m);
    expect(email.subject).toBe('🎉 Hurray! Duevy has processed 1k payments — ₦5,000,000.00 net');
    expect(email.text).toContain('Hurray! Duevy has just processed its 1,000th payment.');
    expect(email.text).toContain('Net to spaces: ₦5,000,000.00');
    expect(email.text).toContain('Paid out to departments: ₦3,800,000.00 (42 withdrawals)');
    expect(email.text).toContain('500 payments in 23 days since we hit 500.');
  });
});

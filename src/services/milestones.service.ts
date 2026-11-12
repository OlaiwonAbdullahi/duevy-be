import { db } from '../config/db';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { sendTransactionMilestoneEmail, type TransactionMilestone } from '../lib/email';
import { computePublicMetrics } from '../routes/publicMetrics';

/**
 * "Hurray, Duevy has processed 1k payments" emails to the admins, once per
 * milestone of paid student payments (checkouts).
 *
 * The last milestone emailed is kept in platform_settings, so each goes out
 * once across restarts and however many workers run. If several were crossed
 * since the last check (e.g. the first run after deploy), only the highest is
 * emailed, never a burst.
 */
const SETTING_KEY = 'milestones.payments';
const FIXED = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

/** The highest milestone at or below `count`; past a million, every million. Null below the first. */
export function highestMilestone(count: number): number | null {
  if (count >= 2_000_000) return Math.floor(count / 1_000_000) * 1_000_000;
  let best: number | null = null;
  for (const m of FIXED) if (count >= m) best = m;
  return best;
}

type Sent = { milestone: number; at: string };

/** Check once; returns the milestone emailed, or null. Safe to call from several workers at once. */
export async function checkPaymentMilestone(now = new Date()): Promise<number | null> {
  const claimed = await db.$transaction(async (tx) => {
    // One checker at a time, so a milestone is claimed exactly once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SETTING_KEY}, 0))`;
    const payments = await tx.checkout.count({ where: { status: 'paid' } });
    const reached = highestMilestone(payments);
    const row = await tx.platformSetting.findUnique({ where: { key: SETTING_KEY } });
    const last = (row?.value as Sent | null) ?? null;
    if (reached === null || (last && reached <= last.milestone)) return null;
    const sent: Sent = { milestone: reached, at: now.toISOString() };
    await tx.platformSetting.upsert({ where: { key: SETTING_KEY }, update: { value: sent }, create: { key: SETTING_KEY, value: sent } });
    return { milestone: reached, previous: last };
  });
  if (!claimed) return null;

  // Claimed before sending, so a slow or failed send can't email it twice; a failure is logged instead.
  const m = await milestoneFigures(claimed.milestone, claimed.previous, now);
  const admins = await db.user.findMany({ where: { role: 'admin', isDeactivated: false }, select: { id: true, name: true, email: true } });
  const sent = await Promise.allSettled(admins.map((a) => sendTransactionMilestoneEmail(a.email, a.name, m)));
  for (const [i, r] of sent.entries()) {
    if (r.status === 'rejected') logger.warn({ milestone: m.milestone, adminId: admins[i]!.id, err: (r.reason as Error)?.message }, 'milestone email failed');
  }
  logger.info({ milestone: m.milestone, payments: m.payments, admins: admins.length }, 'payments milestone reached');
  return m.milestone;
}

async function milestoneFigures(milestone: number, previous: Sent | null, now: Date): Promise<TransactionMilestone> {
  const [metrics, paid, payouts, first] = await Promise.all([
    computePublicMetrics(now),
    db.checkout.aggregate({ where: { status: 'paid' }, _count: { _all: true }, _sum: { totalKobo: true, faceKobo: true, feeKobo: true } }),
    db.payout.aggregate({ where: { status: 'success' }, _count: { _all: true }, _sum: { netKobo: true } }),
    db.checkout.findFirst({ where: { status: 'paid', paidAt: { not: null } }, orderBy: { paidAt: 'asc' }, select: { paidAt: true } }),
  ]);
  return {
    milestone,
    payments: paid._count._all,
    volumeKobo: paid._sum.totalKobo ?? 0,
    netKobo: paid._sum.faceKobo ?? 0,
    feesKobo: paid._sum.feeKobo ?? 0,
    payouts: payouts._count._all,
    paidOutKobo: payouts._sum.netKobo ?? 0,
    spaces: metrics.spaces,
    reps: metrics.reps,
    students: metrics.students,
    campuses: metrics.campuses,
    firstPaymentAt: first?.paidAt ?? null,
    previous: previous ? { milestone: previous.milestone, at: new Date(previous.at) } : null,
    at: now,
    link: `${env.FRONTEND_URL}/admin/overview`,
  };
}

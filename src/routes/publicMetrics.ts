import { Router, type Request, type Response } from 'express';
import { db } from '../config/db';
import { ok, fail } from '../lib/response';
import { logger } from '../lib/logger';

/**
 * Public traction figures for duevy.app/metrics. Aggregate counts and sums
 * only — nothing here may identify a user, space or due.
 *
 * Mounted at /public, unauthenticated.
 */
export const publicMetricsRouter = Router();

export type MetricsMonth = { month: string; volume: number; payments: number };

export type PublicMetrics = {
  students: number;
  reps: number;
  spaces: number;
  campuses: number;
  volume: number;
  payments: number;
  payouts: number;
  monthly: MetricsMonth[];
  updatedAt: string;
};

const MONTHS = 12;
// Lagos is UTC+1 all year (no DST), so a fixed offset is exact.
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** The last `MONTHS` calendar months in Lagos time as `YYYY-MM`, oldest first, plus where the first one starts. */
function monthWindow(now: Date) {
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const y = lagos.getUTCFullYear();
  const m = lagos.getUTCMonth();
  const months: string[] = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const since = new Date(Date.UTC(y, m - (MONTHS - 1), 1) - LAGOS_OFFSET_MS);
  return { months, since };
}

export async function computePublicMetrics(now = new Date()): Promise<PublicMetrics> {
  const { months, since } = monthWindow(now);

  const [students, reps, spaces, campuses, paid, payouts, monthlyRows] = await Promise.all([
    db.user.count({ where: { role: { not: 'admin' }, isGuest: false, isDeactivated: false } }),
    db.user.count({ where: { isRep: true, isSuspended: false, isDeactivated: false } }),
    db.space.count({ where: { isArchived: false } }),
    db.space.groupBy({ by: ['institution'], where: { isArchived: false } }),
    db.checkout.aggregate({ where: { status: 'paid' }, _count: { _all: true }, _sum: { totalKobo: true } }),
    db.payout.count({ where: { status: 'success' } }),
    // paidAt is stored as UTC; bucket it by the Lagos calendar month.
    db.$queryRaw<{ month: string; volume: bigint; payments: number }[]>`
      SELECT to_char(date_trunc('month', ("paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'), 'YYYY-MM') AS month,
             COALESCE(SUM("totalKobo"), 0)::bigint AS volume,
             COUNT(*)::int AS payments
      FROM "checkouts"
      WHERE "status" = 'paid' AND "paidAt" >= ${since}
      GROUP BY 1
    `,
  ]);

  const byMonth = new Map(monthlyRows.map((r) => [r.month, r]));
  const monthly = months.map((month) => {
    const row = byMonth.get(month);
    return { month, volume: row ? Number(row.volume) : 0, payments: row?.payments ?? 0 };
  });
  // Drop the empty months before the first payment so a young platform's
  // chart doesn't open on a run of zeros.
  const first = monthly.findIndex((m) => m.payments > 0);

  return {
    students,
    reps,
    spaces,
    campuses: campuses.length,
    volume: paid._sum.totalKobo ?? 0,
    payments: paid._count._all,
    payouts,
    monthly: first === -1 ? [] : monthly.slice(first),
    updatedAt: now.toISOString(),
  };
}

// Every visitor to the page hits this through the web app's hourly cache, but
// the endpoint is public, so it keeps its own short cache too.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { metrics: PublicMetrics; at: number } | null = null;

/** Reset between tests. */
export function clearPublicMetricsCache() {
  cache = null;
}

async function publicMetricsCached(): Promise<PublicMetrics> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.metrics;
  try {
    const metrics = await computePublicMetrics();
    cache = { metrics, at: Date.now() };
    return metrics;
  } catch (err) {
    if (cache) {
      logger.warn({ err: (err as Error).message }, 'public metrics refresh failed — serving stale figures');
      return cache.metrics;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /public/metrics — platform-wide traction totals
// ---------------------------------------------------------------------------
publicMetricsRouter.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  try {
    const metrics = await publicMetricsCached();
    res.set('Cache-Control', 'public, max-age=300');
    ok(res, metrics);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'public metrics failed');
    fail(res, 503, 'METRICS_UNAVAILABLE', 'Metrics are unavailable right now');
  }
});

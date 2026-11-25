import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { invalidate } from '../../lib/cache';
import { api, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

/**
 * The admin overview splits active reps into leads and co-reps and reports
 * Duevy's profit (revenue less 9jaPay sweep charges). The figures are cached,
 * so each read drops the cache first to measure the effect of a change.
 */
let token: string;
beforeAll(async () => {
  await startHttp();
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_ov_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  token = await tokenFor(admin);
});
afterAll(stopHttp);

async function overview() {
  await invalidate('admin:overview');
  const res = await api('GET', '/v1/admin/overview', { token });
  expect(res.status).toBe(200);
  return res.body.data as {
    activeReps: number;
    activeLeadReps: number;
    activeCoReps: number;
    profit: { total: number; providerFees: number; last30Days: number };
    trends: { day: TrendPoint[]; week: TrendPoint[]; month: TrendPoint[] };
  };
}

type TrendPoint = { bucket: string; volume: number; payments: number; revenue: number; profit: number };

describe('admin overview: rep split and profit', () => {
  it('counts a new lead under reps and a new co-rep under co-reps', async () => {
    const before = await overview();
    expect(typeof before.profit.total).toBe('number');
    expect(typeof before.profit.providerFees).toBe('number');
    // Trends come at three zoom levels, each zero-filled to a fixed length.
    expect(before.trends.day).toHaveLength(24);
    expect(before.trends.week).toHaveLength(7);
    expect(before.trends.month).toHaveLength(30);
    expect(before.trends.day[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/);
    expect(before.trends.week[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const p of [...before.trends.day, ...before.trends.week, ...before.trends.month]) {
      expect(p.profit).toBe(p.revenue - Math.ceil((p.volume * 50) / 10_000));
    }

    // makeSpace provisions one active lead rep.
    const { space } = await makeSpace();
    // A co-rep who assists on that space and leads nothing.
    const co = await db.user.create({
      data: { name: 'Co Rep', email: `co_${Date.now()}_${Math.random()}@test.duevy`, role: 'rep', isRep: true, repApplicationStatus: 'approved' },
    });
    await db.spaceRep.create({ data: { userId: co.id, spaceId: space.id, role: 'co' } });

    const after = await overview();
    expect(after.activeLeadReps).toBe(before.activeLeadReps + 1);
    expect(after.activeCoReps).toBe(before.activeCoReps + 1);
    // The co-rep isn't double-counted as a lead.
    expect(after.activeReps).toBeGreaterThanOrEqual(after.activeLeadReps);
  });
});

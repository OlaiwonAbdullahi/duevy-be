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
  };
}

describe('admin overview: rep split and profit', () => {
  it('counts a new lead under reps and a new co-rep under co-reps', async () => {
    const before = await overview();
    expect(typeof before.profit.total).toBe('number');
    expect(typeof before.profit.providerFees).toBe('number');

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

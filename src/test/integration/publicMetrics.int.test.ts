import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { clearPublicMetricsCache, computePublicMetrics } from '../../routes/publicMetrics';
import { api, makeSpace, startHttp, stopHttp } from './fixtures';

beforeAll(startHttp);
afterAll(stopHttp);

describe('public metrics', () => {
  it('serves aggregate totals without auth and counts a new paid checkout', async () => {
    const before = await computePublicMetrics();

    const { space, students } = await makeSpace({ members: 2 });
    const reference = `chk_metrics_${Date.now()}`;
    await db.checkout.create({
      data: {
        reference, userId: students[0]!.id, spaceId: space.id, status: 'paid',
        faceKobo: 500_000, feeKobo: 12_000, totalKobo: 512_000, dueSetKey: reference,
        expiresAt: new Date(Date.now() + 3600_000), paidAt: new Date(),
      },
    });
    // A guest and an unpaid checkout don't count.
    await db.user.create({ data: { name: 'Guest', email: `guest_${Date.now()}@test.duevy`, isGuest: true } });
    await db.checkout.create({
      data: {
        reference: `${reference}_open`, userId: students[1]!.id, spaceId: space.id,
        faceKobo: 500_000, feeKobo: 12_000, totalKobo: 512_000, dueSetKey: `${reference}_open`,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    clearPublicMetricsCache();
    const res = await api('GET', '/v1/public/metrics');
    expect(res.status).toBe(200);
    const m = res.body.data;

    expect(m.students - before.students).toBe(3); // the rep + 2 members
    expect(m.reps - before.reps).toBe(1);
    expect(m.spaces - before.spaces).toBe(1);
    expect(m.payments - before.payments).toBe(1);
    expect(m.volume - before.volume).toBe(512_000);
    expect(m.campuses).toBeGreaterThanOrEqual(1);

    const thisMonth = m.monthly.at(-1);
    expect(thisMonth.month).toMatch(/^\d{4}-\d{2}$/);
    expect(thisMonth.payments).toBeGreaterThanOrEqual(1);
    expect(m.monthly.length).toBeLessThanOrEqual(12);
    expect(Object.keys(m).sort()).toEqual(
      ['campuses', 'monthly', 'payments', 'payouts', 'reps', 'spaces', 'students', 'updatedAt', 'volume'],
    );
  });
});

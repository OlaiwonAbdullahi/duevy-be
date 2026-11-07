import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '../../config/db';
import { createCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { purgeExpiredAuthTokens, resetAuthPurgeClock } from '../../jobs/reconciliation';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp, tokenFor } from './fixtures';

/**
 * Behaviour the scaling work must not change, under the concurrency it adds:
 * the webhook worker now runs a claimed batch concurrently, several workers
 * may drain at once, and the pay-page throttle lives in the database.
 */

let fake: FakeProvider;

beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

describe('webhook burst on one space', () => {
  it('credits every payment exactly once when many land at once and several workers drain concurrently', async () => {
    const STUDENTS = 25;
    const { space, students, dues } = await makeSpace({ members: STUDENTS, dues: [500_000] });
    const checkouts = await Promise.all(students.map((s) => createCheckout(s.id, [dues[0]!.id]).then((r) => r.checkout)));

    // Every payment delivered twice under its own event id, plus the same
    // outcome under a second id — all at once, as a collection-day burst.
    const deliveries = checkouts.flatMap((c, i) => [
      () => payCheckout(fake, c.reference, { eventId: `burst_${space.id}_${i}` }),
      () => payCheckout(fake, c.reference, { eventId: `burst_${space.id}_${i}` }),
      () => payCheckout(fake, c.reference, { eventId: `burst_${space.id}_${i}_again` }),
    ]);
    const statuses = await Promise.all(deliveries.map((d) => d()));
    expect(statuses.every((s) => s === 200)).toBe(true);

    // Three "instances" draining at once, each running its batch concurrently.
    await Promise.all([drainWebhookQueue(50, 8), drainWebhookQueue(50, 8), drainWebhookQueue(50, 4)]);

    const ids = checkouts.map((c) => c.reference);
    const rows = await db.checkout.findMany({ where: { reference: { in: ids } } });
    expect(rows.every((c) => c.status === 'paid')).toBe(true);
    expect(await db.duePayment.count({ where: { dueId: dues[0]!.id } })).toBe(STUDENTS);
    expect(await db.ledgerEntry.count({ where: { spaceId: space.id, type: 'due_payment' } })).toBe(STUDENTS);
    expect(await db.receipt.count({ where: { spaceId: space.id } })).toBe(STUDENTS);
    expect(await getSpaceBalance(space.id)).toBe(STUDENTS * 500_000);
    const events = await db.webhookEvent.findMany({ where: { providerEventId: { startsWith: `new_transaction:burst_${space.id}_` } } });
    expect(events).toHaveLength(STUDENTS * 2); // the duplicate delivery of each id was deduplicated at enqueue
    expect(events.every((e) => e.status === 'processed')).toBe(true);
  }, 60_000);
});

describe('pay-page status poll', () => {
  it('asks the provider at most once per interval however often (and concurrently) the page polls', async () => {
    const { students, dues } = await makeSpace({ dues: [200_000] });
    const student = students[0]!;
    const token = await tokenFor(student);
    const { checkout } = await createCheckout(student.id, [dues[0]!.id]);
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });

    const providerChecks = () =>
      fake.calls.filter((call) => call.op === 'getCollectionStatus' && (call.args as { accountNumber: string }).accountNumber === c.vaAccountNumber).length;
    const before = providerChecks();

    const polls = await Promise.all(Array.from({ length: 8 }, () => api('GET', `/v1/payments/${checkout.reference}/status`, { token })));
    expect(polls.every((p) => p.status === 200 && p.body.data.status === 'pending')).toBe(true);
    expect(polls[0]!.body.data.receiptNumber).toBeNull();
    expect(providerChecks() - before).toBe(1);
    expect((await db.checkout.findUniqueOrThrow({ where: { id: c.id } })).lastProviderCheckAt).not.toBeNull();

    // The student pays; once the interval has passed the next poll sees it.
    fake.collectionStatus.set(c.vaAccountNumber!, { state: 'paid', receivedKobo: c.totalKobo });
    await db.checkout.update({ where: { id: c.id }, data: { lastProviderCheckAt: new Date(Date.now() - 11_000) } });
    const paid = await api('GET', `/v1/payments/${checkout.reference}/status`, { token });
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe('paid');
    expect(paid.body.data.receiptNumber).toEqual(expect.any(String));
    expect(paid.body.data.transaction).toMatchObject({ reference: checkout.reference, status: 'completed' });
    expect(providerChecks() - before).toBe(2);

    // Someone else's reference is still a 404, and never reaches the provider.
    const other = await makeSpace();
    const stranger = await api('GET', `/v1/payments/${checkout.reference}/status`, { token: await tokenFor(other.students[0]!) });
    expect(stranger.status).toBe(404);
    expect(providerChecks() - before).toBe(2);
  });
});

describe('housekeeping', () => {
  it('purges expired auth tokens and keeps live ones', async () => {
    const { students } = await makeSpace();
    const userId = students[0]!.id;
    const day = 24 * 60 * 60 * 1000;
    const stale = await db.refreshToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 8 * day) } });
    const recent = await db.refreshToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - day) } });
    const live = await db.refreshToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + day) } });
    const oldVerify = await db.emailVerification.create({ data: { userId, token: randomUUID(), expiresAt: new Date(Date.now() - 1000) } });
    const liveVerify = await db.emailVerification.create({ data: { userId, token: randomUUID(), expiresAt: new Date(Date.now() + day) } });
    const oldReset = await db.passwordReset.create({ data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 1000) } });

    resetAuthPurgeClock();
    expect(await purgeExpiredAuthTokens()).toBeGreaterThanOrEqual(3);
    expect(await db.refreshToken.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await db.refreshToken.findUnique({ where: { id: recent.id } })).not.toBeNull(); // inside the retention margin
    expect(await db.refreshToken.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(await db.emailVerification.findUnique({ where: { id: oldVerify.id } })).toBeNull();
    expect(await db.emailVerification.findUnique({ where: { id: liveVerify.id } })).not.toBeNull();
    expect(await db.passwordReset.findUnique({ where: { id: oldReset.id } })).toBeNull();

    // Hourly: an immediate second pass does nothing.
    await db.passwordReset.create({ data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 1000) } });
    expect(await purgeExpiredAuthTokens()).toBe(0);
  });
});

describe('health', () => {
  it('reports readiness with the database reachable, liveness unchanged', async () => {
    const ready = await api('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({ status: 'ready', dbLatencyMs: expect.any(Number) });
    const live = await api('GET', '/health');
    expect(live.status).toBe(200);
    expect(live.body.data.status).toBe('healthy');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { koboToDecimal } from '../../lib/money';
import { createCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp } from './fixtures';

beforeAll(async () => {
  installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

async function paidEvent(id: string, reference: string, amountKobo: number, extra: Record<string, unknown> = {}) {
  return sendWebhook({
    id,
    type: 'collection.succeeded',
    data: { reference, status: 'SUCCEEDED', amount: koboToDecimal(amountKobo), currency: 'NGN', ...extra },
  });
}

describe('webhook idempotency', () => {
  it('applies a payment once however many times, and however concurrently, it is delivered', async () => {
    const { space, students, dues } = await makeSpace({ dues: [500_000, 150_000] });
    const { checkout } = await createCheckout(students[0]!.id, dues.map((d) => d.id));
    expect(checkout.breakdown).toEqual({ face: 650_000, fee: 13_000 + 2_000, total: 665_000 });

    // Same event id, five times — three of them concurrently.
    expect(await paidEvent('evt_dup_1', checkout.reference, checkout.amount)).toBe(200);
    const concurrent = await Promise.all([1, 2, 3].map(() => paidEvent('evt_dup_1', checkout.reference, checkout.amount)));
    expect(concurrent).toEqual([200, 200, 200]);
    expect(await paidEvent('evt_dup_1', checkout.reference, checkout.amount)).toBe(200);
    // The same OUTCOME under a different event id (e.g. a provider re-send).
    expect(await paidEvent('evt_dup_2', checkout.reference, checkout.amount)).toBe(200);

    // Two queued rows (one per distinct event id), processed by concurrent drains.
    expect(await db.webhookEvent.count({ where: { providerEventId: { in: ['evt_dup_1', 'evt_dup_2'] } } })).toBe(2);
    await Promise.all([drainWebhookQueue(), drainWebhookQueue()]);

    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(await db.duePayment.count({ where: { checkoutId: c.id } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { spaceId: space.id, type: 'due_payment' } })).toBe(2);
    expect(await db.receipt.count({ where: { checkoutId: c.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(650_000); // face value, not the fee
    const events = await db.webhookEvent.findMany({ where: { providerEventId: { in: ['evt_dup_1', 'evt_dup_2'] } } });
    expect(events.every((e) => e.status === 'processed')).toBe(true);
    expect((await db.transaction.findUniqueOrThrow({ where: { reference: c.reference } })).status).toBe('completed');
  });

  it('rejects an unsigned or wrongly signed delivery with 401 and stores nothing', async () => {
    const before = await db.webhookEvent.count();
    const res = await fetch(`${(await startHttp())}/v1/webhooks/bachs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bachs-Signature-V2': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}` },
      body: JSON.stringify({ id: 'evt_forged', type: 'collection.succeeded', data: {} }),
    });
    expect(res.status).toBe(401);
    expect(await db.webhookEvent.count()).toBe(before);
  });
});

describe('payment outcomes', () => {
  it('underpayment: no due is marked paid, the checkout is flagged', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook({
      id: `evt_under_${checkout.reference}`,
      type: 'collection.underpaid',
      data: { reference: checkout.reference, amount_paid: '3000.00', amount_expected: koboToDecimal(checkout.amount), status: 'UNDERPAID' },
    });
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('underpaid');
    expect(c.receivedKobo).toBe(300_000);
    expect(c.needsReview).toBe(true);
    expect(await db.duePayment.count({ where: { userId: students[0]!.id } })).toBe(0);
    expect(await getSpaceBalance(space.id)).toBe(0);
  });

  it('overpayment: dues are paid at face value and the excess is flagged', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook({
      id: `evt_over_${checkout.reference}`,
      type: 'collection.succeeded',
      data: {
        reference: checkout.reference,
        status: 'OVERPAID',
        amount: koboToDecimal(checkout.amount),
        received_amount: koboToDecimal(checkout.amount + 100_000),
        overpaid_amount: '1000.00',
      },
    });
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.overpaidKobo).toBe(100_000);
    expect(c.needsReview).toBe(true);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('expiry closes the checkout; money arriving afterwards is still honoured', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook({ id: `evt_exp_${checkout.reference}`, type: 'collection.failed', data: { reference: checkout.reference, status: 'EXPIRED' } });
    await drainWebhookQueue();
    expect((await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).status).toBe('expired');

    // A duplicate expiry is a no-op.
    await sendWebhook({ id: `evt_exp2_${checkout.reference}`, type: 'checkout.expired', data: { reference: checkout.reference } });
    await drainWebhookQueue();

    await paidEvent(`evt_late_${checkout.reference}`, checkout.reference, checkout.amount);
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.reviewReason).toMatch(/after the checkout expired/);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('an event for an unknown checkout is retried, not dropped', async () => {
    await paidEvent('evt_unknown_ref', 'DVY-NOPE-NOPE', 100_000);
    await drainWebhookQueue();
    const e = await db.webhookEvent.findFirstOrThrow({ where: { providerEventId: 'evt_unknown_ref' } });
    expect(e.status).toBe('failed');
    expect(e.attempts).toBe(1);
    expect(e.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('checkout rules', () => {
  it('computes fees server-side and reuses an open checkout for the same basket', async () => {
    const { students, dues } = await makeSpace({ dues: [100_000, 200_000] });
    const first = await createCheckout(students[0]!.id, [dues[0]!.id, dues[1]!.id]);
    const again = await createCheckout(students[0]!.id, [dues[1]!.id, dues[0]!.id]);
    expect(again.reused).toBe(true);
    expect(again.checkout.reference).toBe(first.checkout.reference);
    await expect(createCheckout(students[0]!.id, [dues[0]!.id])).rejects.toMatchObject({ code: 'CHECKOUT_OVERLAP' });
  });

  it('refuses non-members and spaces whose rep has not passed KYC', async () => {
    const a = await makeSpace();
    const b = await makeSpace();
    await expect(createCheckout(b.students[0]!.id, [a.dues[0]!.id])).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    const unverified = await makeSpace({ verified: false });
    await expect(createCheckout(unverified.students[0]!.id, [unverified.dues[0]!.id])).rejects.toMatchObject({ code: 'SPACE_NOT_VERIFIED' });
  });
});

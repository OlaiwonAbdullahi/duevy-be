import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { createCheckout, expireCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { reconcileCheckout } from '../../jobs/reconciliation';
import { installFakeProvider, makeSpace, sendCollectionWebhook, startHttp, stopHttp } from './fixtures';

const fake = installFakeProvider();
beforeAll(async () => {
  await startHttp();
});
afterAll(stopHttp);

describe('webhook idempotency', () => {
  it('applies a payment once however many times, and however concurrently, it is delivered', async () => {
    const { space, students, dues } = await makeSpace({ dues: [500_000, 150_000] });
    const { checkout } = await createCheckout(students[0]!.id, dues.map((d) => d.id));
    // 1.5% of ₦6,500 = ₦97.50, plus ₦20.
    expect(checkout.breakdown).toEqual({ face: 650_000, fee: 9_750 + 2_000, total: 661_750 });
    expect(checkout.checkoutUrl).toBeNull();
    expect(checkout.bankTransfer).toMatchObject({ accountName: 'Duevy Labs Ltd', amountKobo: 661_750 });
    expect(checkout.bankTransfer!.accountNumber).toMatch(/^\d{10}$/);

    // The same transfer (remitReference) delivered five times — three of them concurrently.
    const remit = { remitReference: `dup_${checkout.reference}` };
    expect(await sendCollectionWebhook(checkout.reference, checkout.amount, remit)).toBe(200);
    const concurrent = await Promise.all([1, 2, 3].map(() => sendCollectionWebhook(checkout.reference, checkout.amount, remit)));
    expect(concurrent).toEqual([200, 200, 200]);
    expect(await sendCollectionWebhook(checkout.reference, checkout.amount, remit)).toBe(200);
    expect(await db.webhookEvent.count({ where: { providerEventId: `collection:dup_${checkout.reference}` } })).toBe(1);

    // The same OUTCOME from reconciliation racing the worker.
    fake.collectionStatus.set(checkout.reference, { state: 'paid', receivedKobo: checkout.amount });
    const row = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    await Promise.all([drainWebhookQueue(), drainWebhookQueue(), reconcileCheckout(row, { expireIfPastDue: false, source: 'test' })]);

    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.needsReview).toBe(false);
    expect(await db.duePayment.count({ where: { checkoutId: c.id } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { spaceId: space.id, type: 'due_payment' } })).toBe(2);
    expect(await db.receipt.count({ where: { checkoutId: c.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(650_000); // face value, not the fee
    const events = await db.webhookEvent.findMany({ where: { providerEventId: `collection:dup_${checkout.reference}` } });
    expect(events.every((e) => e.status === 'processed')).toBe(true);
    expect((await db.transaction.findUniqueOrThrow({ where: { reference: c.reference } })).status).toBe('completed');
  });

  it('flags a second, different transfer into a paid checkout for a refund', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendCollectionWebhook(checkout.reference, checkout.amount, { remitReference: `first_${checkout.reference}` });
    await sendCollectionWebhook(checkout.reference, checkout.amount, { remitReference: `second_${checkout.reference}` });
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.needsReview).toBe(true);
    expect(c.reviewReason).toMatch(/another payment/);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('rejects an unsigned or wrongly signed delivery with 401 and stores nothing', async () => {
    const before = await db.webhookEvent.count();
    const res = await fetch(`${(await startHttp())}/v1/webhooks/kredi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'signature-key': 'a'.repeat(128) },
      body: JSON.stringify({ merchantRef: 'DVY-FAKE-FAKE', amount: '1.00', status: 'successful', remitReference: 'forged', accountType: 'collection' }),
    });
    expect(res.status).toBe(401);
    const unsigned = await fetch(`${(await startHttp())}/v1/webhooks/kredi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantRef: 'DVY-FAKE-FAKE', amount: '1.00', status: 'successful', remitReference: 'forged', accountType: 'collection' }),
    });
    expect(unsigned.status).toBe(401);
    expect(await db.webhookEvent.count()).toBe(before);
  });
});

describe('payment outcomes', () => {
  it('underpayment: no due is marked paid, the checkout is flagged', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendCollectionWebhook(checkout.reference, 300_000);
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
    await sendCollectionWebhook(checkout.reference, checkout.amount + 100_000);
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
    const row = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    await expireCheckout(row.id);
    expect((await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).status).toBe('expired');

    await sendCollectionWebhook(checkout.reference, checkout.amount, { remitReference: `late_${checkout.reference}` });
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.reviewReason).toMatch(/after the checkout expired/);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('an event for an unknown checkout is retried, not dropped', async () => {
    await sendCollectionWebhook('DVY-NOPE-NOPE', 100_000, { remitReference: 'unknown_ref' });
    await drainWebhookQueue();
    const e = await db.webhookEvent.findFirstOrThrow({ where: { providerEventId: 'collection:unknown_ref' } });
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

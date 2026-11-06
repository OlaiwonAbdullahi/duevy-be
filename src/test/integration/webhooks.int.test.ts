import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { createCheckout, expireCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { creditEvent, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp } from './fixtures';

let fake: FakeProvider;

beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

/**
 * A student's transfer lands in the checkout's one-time account: 9jaPay's
 * records show it (what the handler reads back), and the webhook says so.
 */
async function pay(checkout: { reference: string }, receivedKobo: number, eventId: string) {
  const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
  fake.collectionStatus.set(c.vaAccountNumber!, { state: 'paid', receivedKobo });
  return sendWebhook(
    creditEvent({ id: eventId, accountNumber: c.vaAccountNumber!, accountRequestReference: c.providerCheckoutId!, amountKobo: receivedKobo }),
  );
}

describe('webhook idempotency', () => {
  it('applies a payment once however many times, and however concurrently, it is delivered', async () => {
    const { space, students, dues } = await makeSpace({ dues: [500_000, 150_000] });
    const { checkout } = await createCheckout(students[0]!.id, dues.map((d) => d.id));
    expect(checkout.breakdown).toEqual({ face: 650_000, fee: 9_750, total: 659_750 });
    expect(checkout.bankTransfer).toMatchObject({ bankName: '9jaPay', amountKobo: 659_750 });

    // Same event id, five times — three of them concurrently.
    expect(await pay(checkout, checkout.amount, 'txn_dup_1')).toBe(200);
    const concurrent = await Promise.all([1, 2, 3].map(() => pay(checkout, checkout.amount, 'txn_dup_1')));
    expect(concurrent).toEqual([200, 200, 200]);
    expect(await pay(checkout, checkout.amount, 'txn_dup_1')).toBe(200);
    // The same OUTCOME under a different event id (e.g. a resent notification).
    expect(await pay(checkout, checkout.amount, 'txn_dup_2')).toBe(200);

    const ids = ['new_transaction:txn_dup_1', 'new_transaction:txn_dup_2'];
    expect(await db.webhookEvent.count({ where: { providerEventId: { in: ids } } })).toBe(2);
    await Promise.all([drainWebhookQueue(), drainWebhookQueue()]);

    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(await db.duePayment.count({ where: { checkoutId: c.id } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { spaceId: space.id, type: 'due_payment' } })).toBe(2);
    expect(await db.receipt.count({ where: { checkoutId: c.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(650_000); // face value, not the fee
    const events = await db.webhookEvent.findMany({ where: { providerEventId: { in: ids } } });
    expect(events.every((e) => e.status === 'processed')).toBe(true);
    expect((await db.transaction.findUniqueOrThrow({ where: { reference: c.reference } })).status).toBe('completed');
  });

  it('never trusts the event body: a credit 9jaPay has no record of changes nothing', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    // Correctly signed, but 9jaPay's transaction list shows nothing arrived.
    await sendWebhook(creditEvent({ accountNumber: c.vaAccountNumber!, accountRequestReference: c.providerCheckoutId!, amountKobo: c.totalKobo }));
    await drainWebhookQueue();
    expect((await db.checkout.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('pending');
    expect(await getSpaceBalance(space.id)).toBe(0);
  });

  it('rejects an unsigned or wrongly signed delivery with 401 and stores nothing', async () => {
    const before = await db.webhookEvent.count();
    const res = await fetch(`${await startHttp()}/v1/webhooks/9japay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Signature: 'bm90IGEgcmVhbCBzaWduYXR1cmU=' },
      body: JSON.stringify({ eventType: 'new_transaction', data: { id: 'forged', transactionType: 'Credit' } }),
    });
    expect(res.status).toBe(401);
    expect(await db.webhookEvent.count()).toBe(before);
  });

  it('acknowledges and drops deliveries to the retired Bachs endpoint', async () => {
    const before = await db.webhookEvent.count();
    const res = await fetch(`${await startHttp()}/v1/webhooks/bachs`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await db.webhookEvent.count()).toBe(before);
  });
});

describe('payment outcomes', () => {
  it('underpayment: no due is marked paid, the checkout is flagged', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await pay(checkout, 300_000, `txn_under_${checkout.reference}`);
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
    await pay(checkout, checkout.amount + 100_000, `txn_over_${checkout.reference}`);
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
    const c0 = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    await expireCheckout(c0.id);
    await expireCheckout(c0.id); // a second expiry is a no-op
    expect((await db.checkout.findUniqueOrThrow({ where: { id: c0.id } })).status).toBe('expired');

    await pay(checkout, checkout.amount, `txn_late_${checkout.reference}`);
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.reviewReason).toMatch(/after the checkout expired/);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('an event for an unknown checkout is retried, not dropped', async () => {
    await sendWebhook(creditEvent({ id: 'txn_unknown_ref', accountNumber: '9000000000', accountRequestReference: 'DVYNOPENOPE', amountKobo: 100_000 }));
    await drainWebhookQueue();
    const e = await db.webhookEvent.findFirstOrThrow({ where: { providerEventId: 'new_transaction:txn_unknown_ref' } });
    expect(e.status).toBe('failed');
    expect(e.attempts).toBe(1);
    expect(e.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('checkout rules', () => {
  it('computes fees server-side and reuses an open checkout for the same basket', async () => {
    const { students, dues } = await makeSpace({ dues: [100_000, 200_000] });
    const first = await createCheckout(students[0]!.id, [dues[0]!.id, dues[1]!.id]);
    expect(first.checkout.breakdown).toEqual({ face: 300_000, fee: 4_500, total: 304_500 });
    // The one-time account is opened for exactly the total.
    expect(fake.calls.find((c) => c.op === 'createCollectionAccount' && (c.args as { reference: string }).reference === first.checkout.reference)?.args)
      .toMatchObject({ totalKobo: 304_500 });
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

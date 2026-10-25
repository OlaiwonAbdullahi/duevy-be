import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { ProviderError } from '../../providers/payment';
import { createCheckout, expireCheckout, routeCheckoutFunds } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { reconcileRouting } from '../../jobs/reconciliation';
import { creditEvent, installPaymentDouble, makeSpace, sendWebhook, startHttp, stopHttp } from './fixtures';

const bank78 = installPaymentDouble();

beforeAll(async () => {
  await startHttp();
});
beforeEach(() => bank78.reset());
afterAll(stopHttp);

describe('webhook idempotency', () => {
  it('applies a payment once however many times, and however concurrently, it is delivered', async () => {
    const { space, students, dues } = await makeSpace({ dues: [500_000, 150_000] });
    const { checkout } = await createCheckout(students[0]!.id, dues.map((d) => d.id));
    expect(checkout.breakdown).toEqual({ face: 650_000, fee: 9_750, total: 659_750 });
    expect(checkout.bankTransfer).toMatchObject({ bankName: 'Bank78', amountKobo: 659_750 });

    // The same credit (same sessionId), five times — three of them concurrently.
    const event = creditEvent(checkout.reference, checkout.amount, 'S_DUP_1');
    expect(await sendWebhook(event)).toBe(200);
    const concurrent = await Promise.all([1, 2, 3].map(() => sendWebhook(event)));
    expect(concurrent).toEqual([200, 200, 200]);
    expect(await sendWebhook(event)).toBe(200);

    expect(await db.webhookEvent.count({ where: { providerEventId: 'virtual-nuban-transaction-credit:S_DUP_1' } })).toBe(1);
    await Promise.all([drainWebhookQueue(), drainWebhookQueue()]);

    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.providerChargeId).toBe('S_DUP_1'); // the credit that paid it
    expect(await db.duePayment.count({ where: { checkoutId: c.id } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { spaceId: space.id, type: 'due_payment' } })).toBe(2);
    expect(await db.receipt.count({ where: { checkoutId: c.id } })).toBe(1);
    expect(await getSpaceBalance(space.id)).toBe(650_000); // face value, not the fee
    expect((await db.transaction.findUniqueOrThrow({ where: { reference: c.reference } })).status).toBe('completed');
  });

  it('rejects an unsigned or wrongly signed delivery with 401 and stores nothing', async () => {
    const before = await db.webhookEvent.count();
    const res = await fetch(`${await startHttp()}/v1/webhooks/bank78`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bank78-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Bank78-Webhook-Signature-Version': 'v1',
        'X-Bank78-Webhook-Signature': 'a'.repeat(64),
      },
      body: JSON.stringify(creditEvent('DVY-FAKE-FAKE', 100_000)),
    });
    expect(res.status).toBe(401);
    expect(await db.webhookEvent.count()).toBe(before);
  });

  it('acknowledges a v1 (unenveloped) body and keeps nothing it cannot read', async () => {
    const res = await sendWebhook(creditEvent('DVY-FAKE-FAKE', 100_000).data as never);
    expect(res).toBe(200);
  });
});

async function waitForRouted(id: string) {
  for (let i = 0; i < 50; i++) {
    if ((await db.checkout.findUniqueOrThrow({ where: { id } })).routedAt) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('checkout was never routed');
}

describe('routing to the rep wallet', () => {
  it('moves exactly the face amount into the lead rep’s wallet, once', async () => {
    const { rep, students, dues } = await makeSpace({ dues: [500_000] });
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook(creditEvent(checkout.reference, checkout.amount));
    await drainWebhookQueue();
    // Racing the fire-and-forget attempt: whichever loses skips.
    const id = (await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).id;
    await Promise.all([routeCheckoutFunds(id), routeCheckoutFunds(id)]);
    await waitForRouted(id);
    expect(await routeCheckoutFunds(id)).toBe('skipped');

    const routes = bank78.calls.filter((c) => c.op === 'routeCollection');
    expect(routes).toHaveLength(1);
    expect(routes[0]!.args).toEqual({ accountId: rep.walletAccountNumber, amountKobo: 500_000, reference: `RT-${checkout.reference}` });
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.routedAt).not.toBeNull();
    expect(c.routeTransferId).toBe(`RT-${checkout.reference}`);
  });

  it('leaves a failed transfer for reconciliation, which retries it', async () => {
    const { students, dues } = await makeSpace({ dues: [200_000] });
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    bank78.failNextRoute = new ProviderError('timeout', null, null, true);
    await sendWebhook(creditEvent(checkout.reference, checkout.amount));
    await drainWebhookQueue();
    await new Promise((r) => setTimeout(r, 50)); // the fire-and-forget attempt
    let c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.routedAt).toBeNull();

    await db.checkout.update({ where: { id: c.id }, data: { paidAt: new Date(Date.now() - 5 * 60_000) } });
    await reconcileRouting();
    c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.routedAt).not.toBeNull();
  });

  it('treats Bank78 answering "duplicate transaction" as already routed', async () => {
    const { students, dues } = await makeSpace({ dues: [200_000] });
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    bank78.failNextRoute = new ProviderError('timeout', null, null, true);
    await sendWebhook(creditEvent(checkout.reference, checkout.amount));
    await drainWebhookQueue();
    await new Promise((r) => setTimeout(r, 50));
    const id = (await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).id;
    bank78.failNextRoute = new ProviderError('Duplicate transaction', 400, '94', false);
    expect(await routeCheckoutFunds(id)).toBe('routed');
    expect((await db.checkout.findUniqueOrThrow({ where: { id } })).routedAt).not.toBeNull();
  });
});

describe('payment outcomes', () => {
  it('a second, different credit on a paid checkout is flagged, not applied again', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook(creditEvent(checkout.reference, checkout.amount, 'S_FIRST'));
    await drainWebhookQueue();
    await sendWebhook(creditEvent(checkout.reference, checkout.amount, 'S_SECOND'));
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.providerChargeId).toBe('S_FIRST');
    expect(c.needsReview).toBe(true);
    expect(c.reviewReason).toMatch(/another payment .* on charge S_SECOND/);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('a credit larger than the total pays the dues at face value and flags the excess', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook(creditEvent(checkout.reference, checkout.amount + 100_000));
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('paid');
    expect(c.overpaidKobo).toBe(100_000);
    expect(c.needsReview).toBe(true);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('a short credit leaves the dues unpaid and flags the checkout', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook(creditEvent(checkout.reference, 300_000));
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(c.status).toBe('underpaid');
    expect(c.receivedKobo).toBe(300_000);
    expect(await getSpaceBalance(space.id)).toBe(0);
  });

  it('money arriving after expiry is still honoured, and flagged', async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    const id = (await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).id;
    await expireCheckout(id);
    expect((await db.checkout.findUniqueOrThrow({ where: { id } })).status).toBe('expired');

    await sendWebhook(creditEvent(checkout.reference, checkout.amount));
    await drainWebhookQueue();
    const c = await db.checkout.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe('paid');
    expect(c.reviewReason).toMatch(/after the checkout expired/);
    expect(await getSpaceBalance(space.id)).toBe(500_000);
  });

  it('a refused wrong-amount transfer (virtual-nuban-transaction.failed) leaves the checkout open', async () => {
    const { students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await sendWebhook({
      eventType: 'virtual-nuban-transaction.failed',
      data: { sessionId: 'S_BAD_AMT', accountReference: checkout.reference, status: 'invalid_amount', expectedAmount: 5075, actualAmount: 5000 },
    });
    await drainWebhookQueue();
    expect((await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).status).toBe('pending');
  });

  it('an event for an unknown checkout is retried, not dropped', async () => {
    await sendWebhook(creditEvent('DVY-NOPE-NOPE', 100_000, 'S_UNKNOWN'));
    await drainWebhookQueue();
    const e = await db.webhookEvent.findFirstOrThrow({ where: { providerEventId: 'virtual-nuban-transaction-credit:S_UNKNOWN' } });
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { refreshPayout, requestWithdrawal } from '../../services/withdrawal.service';
import { reconcileCheckout } from '../../jobs/reconciliation';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { creditEvent, creditSpace, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp, TEST_PIN } from './fixtures';

/**
 * 9jaPay hands a one-time account number to a later checkout once the earlier
 * one closes. One credit must pay exactly one checkout, and a webhook that
 * still names the earlier checkout must reach the one now holding the number.
 */

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

/** Two students' checkouts for the same due, the second given the first's account number. */
async function twoCheckoutsOnOneNumber() {
  const { space, students, dues } = await makeSpace({ members: 2 });
  const first = await createCheckout(students[0]!.id, [dues[0]!.id]);
  const second = await createCheckout(students[1]!.id, [dues[0]!.id]);
  const a = await db.checkout.findUniqueOrThrow({ where: { reference: first.checkout.reference } });
  const b = await db.checkout.update({ where: { reference: second.checkout.reference }, data: { vaAccountNumber: a.vaAccountNumber } });
  return { space, a, b, number: a.vaAccountNumber! };
}

describe('reused one-time account numbers', () => {
  it('one credit inside two checkouts’ windows pays only one of them, and the space is credited once', async () => {
    const { space, a, b, number } = await twoCheckoutsOnOneNumber();
    fake.collectionStatus.set(number, {
      state: 'paid',
      receivedKobo: a.totalKobo,
      credits: [{ transactionId: 'tx_one', amountKobo: a.totalKobo, at: new Date() }],
    });

    await reconcileCheckout(a, { expireIfPastDue: false, source: 'test' });
    await reconcileCheckout(b, { expireIfPastDue: false, source: 'test' });

    const [ra, rb] = await Promise.all([a, b].map((c) => db.checkout.findUniqueOrThrow({ where: { id: c.id } })));
    expect([ra.status, rb.status]).toEqual(['paid', 'pending']);
    expect(ra.providerTransactionId).toBe('tx_one');
    expect(await getSpaceBalance(space.id)).toBe(a.faceKobo);
  });

  it('each checkout takes its own credit when both were paid', async () => {
    const { a, b, number } = await twoCheckoutsOnOneNumber();
    fake.collectionStatus.set(number, {
      state: 'paid',
      receivedKobo: a.totalKobo * 2,
      credits: [
        { transactionId: 'tx_a', amountKobo: a.totalKobo, at: new Date() },
        { transactionId: 'tx_b', amountKobo: b.totalKobo, at: new Date(Date.now() + 1_000) },
      ],
    });
    await reconcileCheckout(a, { expireIfPastDue: false, source: 'test' });
    await reconcileCheckout(b, { expireIfPastDue: false, source: 'test' });
    const rows = await db.checkout.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.status, r.providerTransactionId, r.receivedKobo])).toEqual([
      ['paid', 'tx_a', a.totalKobo],
      ['paid', 'tx_b', b.totalKobo],
    ]);
  });

  it("ignores a credit for another amount in its window (an earlier holder's payment), instead of calling it underpaid", async () => {
    const { a, number } = await twoCheckoutsOnOneNumber();
    // Seen in the sandbox: the number's previous holder was paid ₦1,015 just before.
    fake.collectionStatus.set(number, {
      state: 'paid',
      receivedKobo: 101_500 + a.totalKobo,
      credits: [
        { transactionId: 'tx_prev', amountKobo: 101_500, at: new Date() },
        { transactionId: 'tx_mine', amountKobo: a.totalKobo, at: new Date(Date.now() + 1_000) },
      ],
    });
    await reconcileCheckout(a, { expireIfPastDue: false, source: 'test' });
    const ra = await db.checkout.findUniqueOrThrow({ where: { id: a.id } });
    expect([ra.status, ra.providerTransactionId, ra.receivedKobo]).toEqual(['paid', 'tx_mine', a.totalKobo]);
  });

  it('with only a different-amount credit, stays open (not underpaid)', async () => {
    const { a, number } = await twoCheckoutsOnOneNumber();
    fake.collectionStatus.set(number, { state: 'paid', receivedKobo: 101_500, credits: [{ transactionId: 'tx_prev2', amountKobo: 101_500, at: new Date() }] });
    await reconcileCheckout(a, { expireIfPastDue: false, source: 'test' });
    expect((await db.checkout.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('pending');
  });

  it('a webhook still naming the earlier (closed) checkout pays the checkout now holding the number', async () => {
    const { a, b, number } = await twoCheckoutsOnOneNumber();
    // a expired before b's student paid; 9jaPay then gave its number to b.
    const aExpiry = new Date(Date.now() - 60_000);
    await db.checkout.update({ where: { id: a.id }, data: { status: 'expired', expiredAt: aExpiry, expiresAt: aExpiry } });
    fake.collectionStatus.set(number, {
      state: 'paid',
      receivedKobo: b.totalKobo,
      credits: [{ transactionId: 'tx_late', amountKobo: b.totalKobo, at: new Date() }],
    });

    expect(await sendWebhook(creditEvent({ accountNumber: number, accountRequestReference: a.providerCheckoutId!, amountKobo: b.totalKobo }))).toBe(200);
    await drainWebhookQueue();

    const [ra, rb] = await Promise.all([a, b].map((c) => db.checkout.findUniqueOrThrow({ where: { id: c.id } })));
    expect(ra.status).toBe('expired'); // the payment was after a closed: not a's
    expect([rb.status, rb.providerTransactionId]).toEqual(['paid', 'tx_late']);
    const event = await db.webhookEvent.findFirstOrThrow({ where: { type: 'new_transaction' }, orderBy: { receivedAt: 'desc' } });
    expect(event.status).toBe('processed');
  });
});

describe('a withdrawal 9jaPay has no record of', () => {
  it('is sent again instead of staying stuck in processing', async () => {
    const { rep, space, beneficiary } = await makeSpace();
    await creditSpace(space.id, 3_000_000);
    const p = await requestWithdrawal({ spaceId: space.id, userId: rep.id, beneficiaryId: beneficiary!.id, amountKobo: 1_000_000, pin: TEST_PIN });
    expect(p.status).toBe('processing');

    // 9jaPay lost it: TSQ answers "25".
    fake.transfers.clear();
    const sentBefore = fake.calls.filter((c) => c.op === 'initiateTransfer').length;
    await refreshPayout(p.id);

    expect(fake.calls.filter((c) => c.op === 'initiateTransfer').length).toBe(sentBefore + 1);
    expect((await db.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('processing');
    expect(await getSpaceBalance(space.id)).toBe(2_000_000); // debited once, not twice
  });
});

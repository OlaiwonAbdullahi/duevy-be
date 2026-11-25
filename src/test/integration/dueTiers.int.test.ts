import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { getSpaceBalance } from '../../services/ledger.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

let seq = 0;
const guestEmail = () => `tier_${Date.now()}_${seq++}@test.duevy`;

async function pay(reference: string, amountKobo: number) {
  await payCheckout(fake, reference, { receivedKobo: amountKobo });
  await drainWebhookQueue();
}

/** Create a published, guest-enabled tiered due through the rep API. */
async function makeTieredDue(spaceId: string, repToken: string) {
  const res = await api('POST', `/v1/spaces/${spaceId}/dues`, {
    token: repToken,
    body: {
      title: 'Faculty Week Levy',
      type: 'other',
      publish: true,
      allowGuests: true,
      pricingMode: 'tiered',
      tiers: [
        { label: '100 level', amountKobo: 300_000 },
        { label: 'Final year', amountKobo: 500_000 },
      ],
    },
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; pricingMode: string; tiers: { id: string; label: string; amountKobo: number }[] };
}

describe('tiered due amounts', () => {
  it('rejects a tiered due with no tiers, and a flat due carrying tiers', async () => {
    const { space, rep } = await makeSpace();
    const repToken = await tokenFor(rep);
    const noTiers = await api('POST', `/v1/spaces/${space.id}/dues`, {
      token: repToken,
      body: { title: 'Bad tiered', type: 'other', pricingMode: 'tiered' },
    });
    expect(noTiers.status).toBe(400);
    expect(noTiers.body.error.details[0]).toMatchObject({ field: 'tiers' });

    const flatWithTiers = await api('POST', `/v1/spaces/${space.id}/dues`, {
      token: repToken,
      body: { title: 'Bad flat', type: 'other', amount: 100_000, pricingMode: 'flat', tiers: [{ label: 'x', amountKobo: 100_000 }] },
    });
    expect(flatWithTiers.status).toBe(400);
  });

  it('creates a tiered due and shows its options on the public pay page', async () => {
    const { space, rep } = await makeSpace();
    const repToken = await tokenFor(rep);
    const due = await makeTieredDue(space.id, repToken);
    expect(due.pricingMode).toBe('tiered');
    expect(due.tiers).toHaveLength(2);

    const pub = await api('GET', `/v1/public/dues/${due.id}`);
    expect(pub.status).toBe(200);
    // No single amount for a tiered due; each tier carries its own fee/total.
    expect(pub.body.data).toMatchObject({ pricingMode: 'tiered', amount: null, fee: null, total: null });
    expect(pub.body.data.tiers).toEqual([
      expect.objectContaining({ label: '100 level', amount: 300_000, fee: 4_500, total: 304_500 }),
      expect.objectContaining({ label: 'Final year', amount: 500_000, fee: 7_500, total: 507_500 }),
    ]);
  });

  it('charges and pins the chosen tier end to end', async () => {
    const { space, rep } = await makeSpace();
    const repToken = await tokenFor(rep);
    const due = await makeTieredDue(space.id, repToken);
    const tier100 = due.tiers.find((t) => t.label === '100 level')!;

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'Tolu Ade', matricNo: 'FAC/21/001', email: guestEmail(), tierId: tier100.id },
    });
    expect(opened.status).toBe(201);
    const { reference, amount } = opened.body.data;
    expect(amount).toBe(304_500); // the 100-level tier plus its 1.5% fee

    await pay(reference, amount);

    // The chosen tier is pinned onto the line and the payment, and credited net.
    const item = await db.checkoutItem.findFirstOrThrow({ where: { checkout: { reference } } });
    expect(item).toMatchObject({ faceKobo: 300_000, tierLabel: '100 level', tierId: tier100.id });
    const payment = await db.duePayment.findFirstOrThrow({ where: { dueId: due.id } });
    expect(payment).toMatchObject({ amountPaid: 304_500, netToSpace: 300_000 });
    expect(await getSpaceBalance(space.id)).toBe(300_000);
  });

  it('requires a valid tier on a tiered due and refuses one on a flat due', async () => {
    const { space, rep, dues } = await makeSpace();
    const repToken = await tokenFor(rep);
    const due = await makeTieredDue(space.id, repToken);

    const missing = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'A B', matricNo: 'FAC/1', email: guestEmail() },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('TIER_REQUIRED');

    const foreign = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'A B', matricNo: 'FAC/2', email: guestEmail(), tierId: 'dtr_does_not_exist' },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('TIER_INVALID');

    // A flat (default) due must reject a tier selection.
    const flat = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const onFlat = await api('POST', `/v1/public/dues/${flat.id}/checkout`, {
      body: { name: 'A B', matricNo: 'FAC/3', email: guestEmail(), tierId: 'dtr_anything' },
    });
    expect(onFlat.status).toBe(400);
    expect(onFlat.body.error.code).toBe('TIER_NOT_ALLOWED');
  });

  it('freezes pricing once paid, and keeps a paid line unchanged when a tier is archived', async () => {
    const { space, rep } = await makeSpace();
    const repToken = await tokenFor(rep);
    const due = await makeTieredDue(space.id, repToken);
    const tier100 = due.tiers.find((t) => t.label === '100 level')!;

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'Paid Payer', matricNo: 'FAC/9', email: guestEmail(), tierId: tier100.id },
    });
    await pay(opened.body.data.reference, opened.body.data.amount);

    // Editing tiers after a payment is refused.
    const edit = await api('PATCH', `/v1/spaces/${space.id}/dues/${due.id}`, {
      token: repToken,
      body: { tiers: [{ label: 'New', amountKobo: 999_000 }] },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('DUE_HAS_PAYMENTS');

    // Archiving the tier directly never rewrites the pinned snapshot.
    await db.dueTier.update({ where: { id: tier100.id }, data: { isArchived: true } });
    const item = await db.checkoutItem.findFirstOrThrow({ where: { checkout: { reference: opened.body.data.reference } } });
    expect(item).toMatchObject({ faceKobo: 300_000, tierLabel: '100 level' });
  });
});

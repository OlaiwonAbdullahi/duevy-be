import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout } from '../../services/checkout.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { api, creditSpace, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

describe('GET /spaces/:spaceId/ledger/:entryId', () => {
  it("shows a due payment's payer, due and amounts", async () => {
    const { rep, space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    await payCheckout(fake, checkout.reference, { receivedKobo: checkout.amount });
    await drainWebhookQueue();

    const token = await tokenFor(rep);
    const list = await api('GET', `/v1/spaces/${space.id}/ledger`, { token });
    const entry = list.body.data.find((e: { type: string }) => e.type === 'due_payment');
    const res = await api('GET', `/v1/spaces/${space.id}/ledger/${entry.id}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: entry.id,
      type: 'due_payment',
      due: { id: dues[0]!.id, title: dues[0]!.title },
      payment: { payerName: students[0]!.name, email: students[0]!.email, guest: false, netToSpace: dues[0]!.amount },
      deposit: null,
    });
    expect(res.body.data.payment.amountPaid).toBe(res.body.data.payment.netToSpace + res.body.data.payment.fee);
  });

  it("names a manual credit and refuses other spaces' entries and non-reps", async () => {
    const { rep, space } = await makeSpace();
    await creditSpace(space.id, 10_000, 'Goodwill credit');
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { spaceId: space.id, type: 'manual_credit' } });
    const token = await tokenFor(rep);

    const res = await api('GET', `/v1/spaces/${space.id}/ledger/${entry.id}`, { token });
    expect(res.body.data).toMatchObject({ type: 'manual_credit', description: 'Goodwill credit', payment: null, deposit: null });

    const other = await makeSpace();
    expect((await api('GET', `/v1/spaces/${other.space.id}/ledger/${entry.id}`, { token: await tokenFor(other.rep) })).status).toBe(404);
    expect((await api('GET', `/v1/spaces/${space.id}/ledger/${entry.id}`, { token: await tokenFor(other.rep) })).status).toBe(403);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

let seq = 0;
const guestEmail = () => `lookup_${Date.now()}_${seq++}@test.duevy`;

describe('public payment lookup', () => {
  it('confirms a paid matric with a verifiable receipt, and leaks no PII', async () => {
    const { dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const email = guestEmail();
    const matric = 'FAC/21/777';

    const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
      body: { name: 'Bisi Alabi', matricNo: matric, email },
    });
    await payCheckout(fake, opened.body.data.reference, { receivedKobo: opened.body.data.amount });
    await drainWebhookQueue();

    const hit = await api('GET', `/v1/public/dues/${due.id}/lookup?matric=${encodeURIComponent(matric)}`);
    expect(hit.status).toBe(200);
    expect(hit.body.data.paid).toBe(true);
    expect(hit.body.data.receiptNumber).toBeTruthy();
    // Masked name only — never the email, phone, or full name.
    expect(hit.body.data.name).not.toBe('Bisi Alabi');
    expect(JSON.stringify(hit.body.data)).not.toContain(email);

    // The receipt number from the lookup actually verifies.
    const verify = await api('GET', `/v1/public/receipts/verify/${hit.body.data.receiptNumber}`);
    expect(verify.status).toBe(200);
  });

  it('reports an unpaid matric as not paid', async () => {
    const { dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const res = await api('GET', `/v1/public/dues/${due.id}/lookup?matric=NOBODY/0`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ paid: false });
  });

  it('requires a matric and never reveals a members-only due', async () => {
    const { dues } = await makeSpace();
    // Members-only (guests off): same 404 as an unknown link.
    const closed = await api('GET', `/v1/public/dues/${dues[0]!.id}/lookup?matric=FAC/1`);
    expect(closed.status).toBe(404);

    const open = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    const noMatric = await api('GET', `/v1/public/dues/${open.id}/lookup`);
    expect(noMatric.status).toBe(400);
  });
});

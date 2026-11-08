import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout } from '../../services/checkout.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp, tokenFor } from './fixtures';

let fake: FakeProvider;
let base: string;
beforeAll(async () => {
  fake = installFakeProvider();
  base = await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

/** The PDF route answers with a binary body, so read it with plain fetch. */
async function getPdf(path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, disposition: res.headers.get('content-disposition') ?? '', type: res.headers.get('content-type') ?? '' };
}

describe('GET /dues/:dueId/receipt', () => {
  it('gives each due of a multi-due payment its own receipt, numbered after the full one', async () => {
    const { students, dues } = await makeSpace({ dues: [500_000, 300_000] });
    const student = students[0]!;
    const { checkout } = await createCheckout(student.id, dues.map((d) => d.id));
    await payCheckout(fake, checkout.reference, { receivedKobo: checkout.amount });
    await drainWebhookQueue();

    const receipt = await db.receipt.findFirstOrThrow({ where: { userId: student.id } });
    const token = await tokenFor(student);
    const files = await Promise.all(dues.map((d) => getPdf(`/v1/dues/${d.id}/receipt`, token)));

    for (const f of files) {
      expect(f.status).toBe(200);
      expect(f.type).toContain('application/pdf');
    }
    const names = files.map((f) => /filename="([^"]+)"/.exec(f.disposition)?.[1]);
    expect(new Set(names).size).toBe(2);
    expect(names.sort()).toEqual([`receipt-${receipt.number}-1.pdf`, `receipt-${receipt.number}-2.pdf`]);
  });

  it('keeps the plain receipt number for a single-due payment', async () => {
    const { students, dues } = await makeSpace();
    const student = students[0]!;
    const { checkout } = await createCheckout(student.id, [dues[0]!.id]);
    await payCheckout(fake, checkout.reference, { receivedKobo: checkout.amount });
    await drainWebhookQueue();

    const receipt = await db.receipt.findFirstOrThrow({ where: { userId: student.id } });
    const f = await getPdf(`/v1/dues/${dues[0]!.id}/receipt`, await tokenFor(student));
    expect(f.status).toBe(200);
    expect(f.disposition).toContain(`receipt-${receipt.number}.pdf`);
  });
});

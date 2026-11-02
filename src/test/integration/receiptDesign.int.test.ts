import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { koboToDecimal } from '../../lib/money';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { createCheckout } from '../../services/checkout.service';
import { api, apiMultipart, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp, tokenFor } from './fixtures';

beforeAll(async () => {
  installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

const ASSETS = path.join(__dirname, '../../../assets/images');
const jpeg = readFileSync(path.join(ASSETS, 'doodle-card.jpg'));
const png = readFileSync(path.join(ASSETS, 'duevy-logo-white.png'));

async function pdf(urlPath: string, token: string) {
  const res = await fetch(`${await startHttp()}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

describe('receipt design', () => {
  it('starts from the standard design and saves what the lead rep changes', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/receipt-design`;

    const empty = await api('GET', base, { token });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ accent: null, headerStyle: 'artwork', showStamp: true, logo: null });

    expect((await api('PUT', base, { token, body: { accent: 'green' } })).status).toBe(400);

    const saved = await api('PUT', base, {
      token,
      body: {
        accent: '#1D4ED8',
        headerStyle: 'solid',
        title: 'Official receipt',
        stampText: 'Settled',
        thankYou: 'Thanks for supporting NACOS!',
        note: 'Collect your T-shirt from Room 12 after lectures.',
        showAnswers: true,
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ accent: '#1d4ed8', headerStyle: 'solid', title: 'Official receipt' });

    // Blank text falls back to the default wording.
    const cleared = await api('PUT', base, { token, body: { ...saved.body.data, title: '  ', logo: undefined, signatures: undefined, updatedAt: undefined } });
    expect(cleared.body.data.title).toBeNull();
  });

  it('takes a PNG or JPEG logo, and nothing else', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/receipt-design`;

    const notImage = await apiMultipart(`${base}/logo`, { token, files: { file: { bytes: Buffer.from('%PDF-1.4 hello world'), name: 'x.png', type: 'image/png' } } });
    expect(notImage.status).toBe(415);

    const logo = await apiMultipart(`${base}/logo`, { token, files: { file: { bytes: jpeg, name: 'logo.jpg', type: 'image/jpeg' } } });
    expect(logo.status).toBe(200);
    expect(logo.body.data.logo).toMatch(/^data:image\/jpeg;base64,/);
    const removed = await api('DELETE', `${base}/logo`, { token });
    expect(removed.body.data.logo).toBeNull();
  });

  it('signs receipts with up to three signatories, each with a name, role and image', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/receipt-design`;

    for (let i = 0; i < 3; i++) expect((await api('POST', `${base}/signatures`, { token })).status).toBe(200);
    const fourth = await api('POST', `${base}/signatures`, { token });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('SIGNATURE_LIMIT');

    const listed = (await api('GET', base, { token })).body.data.signatures as { id: string }[];
    expect(listed).toHaveLength(3);
    const [a, b, c] = listed.map((s) => s.id);

    const img = await apiMultipart(`${base}/signatures/${b}/image`, { token, files: { file: { bytes: png, name: 'sig.png', type: 'image/png' } } });
    expect(img.status).toBe(200);
    expect(img.body.data.signatures[1].image).toMatch(/^data:image\/png;base64,/);
    const wrongType = await apiMultipart(`${base}/signatures/${b}/image`, { token, files: { file: { bytes: Buffer.from('%PDF-1.4 hello world'), name: 'x.png', type: 'image/png' } } });
    expect(wrongType.status).toBe(415);

    // Names, roles and order are saved with the design; the order given is the print order.
    const saved = await api('PUT', base, {
      token,
      body: { signatures: [{ id: c, name: 'Tunde', role: 'Treasurer' }, { id: a, name: 'Ada Obi', role: 'Class rep' }, { id: b, name: ' ' }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.signatures.map((s: { id: string; name: string | null }) => [s.id, s.name])).toEqual([[c, 'Tunde'], [a, 'Ada Obi'], [b, null]]);

    const sample = await pdf(`${base}/sample`, token);
    expect(sample.status).toBe(200);
    expect(sample.type).toContain('application/pdf');
    if (process.env.RECEIPT_SAMPLE_OUT) writeFileSync(process.env.RECEIPT_SAMPLE_OUT, sample.bytes);

    const removed = await api('DELETE', `${base}/signatures/${a}`, { token });
    expect(removed.body.data.signatures.map((s: { id: string }) => s.id)).toEqual([c, b]);
    expect((await api('DELETE', `${base}/signatures/${a}`, { token })).status).toBe(404);

    // Another space's rep can't touch these.
    const other = await makeSpace();
    const otherToken = await tokenFor(other.rep);
    expect((await api('DELETE', `/v1/spaces/${other.space.id}/receipt-design/signatures/${c}`, { token: otherToken })).status).toBe(404);
  });

  it('styles the stamp: a shape and colour, or the space\'s own stamp image', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/receipt-design`;

    expect((await api('PUT', base, { token, body: { stampStyle: 'star' } })).status).toBe(400);
    const styled = await api('PUT', base, { token, body: { stampStyle: 'ribbon', stampColor: '#B91C1C', stampText: 'Received' } });
    expect(styled.body.data).toMatchObject({ stampStyle: 'ribbon', stampColor: '#b91c1c', stampImage: null });

    const uploaded = await apiMultipart(`${base}/stamp`, { token, files: { file: { bytes: png, name: 'stamp.png', type: 'image/png' } } });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data.stampImage).toMatch(/^data:image\/png;base64,/);
    expect((await pdf(`${base}/sample`, token)).status).toBe(200);

    const removed = await api('DELETE', `${base}/stamp`, { token });
    expect(removed.body.data).toMatchObject({ stampImage: null, stampStyle: 'ribbon' });
  });

  it('keeps members out and leaves changes to the lead rep', async () => {
    const { space, students } = await makeSpace({ members: 1 });
    const student = await tokenFor(students[0]!);
    expect((await api('GET', `/v1/spaces/${space.id}/receipt-design`, { token: student })).status).toBe(403);

    const co = await db.user.create({ data: { name: 'Co Rep', email: `co_${Date.now()}@test.duevy`, role: 'rep', isRep: true } });
    await db.spaceRep.create({ data: { userId: co.id, spaceId: space.id, role: 'co' } });
    const coToken = await tokenFor(co);
    expect((await api('GET', `/v1/spaces/${space.id}/receipt-design`, { token: coToken })).status).toBe(200);
    expect((await api('PUT', `/v1/spaces/${space.id}/receipt-design`, { token: coToken, body: { title: 'Mine' } })).status).toBe(403);
  });

  it("styles a real payer's receipt with the space's design", async () => {
    const { rep, space, students, dues } = await makeSpace({ members: 1 });
    await api('PUT', `/v1/spaces/${space.id}/receipt-design`, {
      token: await tokenFor(rep),
      body: { accent: '#b91c1c', note: 'See you at the dinner!' },
    });

    const studentToken = await tokenFor(students[0]!);
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    const { reference, amount } = checkout;
    await sendWebhook({
      id: `evt_design_${reference}`,
      type: 'collection.succeeded',
      data: { reference, status: 'SUCCEEDED', amount: koboToDecimal(amount), currency: 'NGN' },
    });
    await drainWebhookQueue();

    const receipt = await db.receipt.findFirstOrThrow({ where: { checkout: { reference } } });
    const res = await pdf(`/v1/receipts/${receipt.number}?format=pdf`, studentToken);
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/pdf');
  });
});

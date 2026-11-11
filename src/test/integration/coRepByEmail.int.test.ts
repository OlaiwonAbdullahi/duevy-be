import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';
import { api, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
}));

beforeAll(async () => {
  await startHttp();
});
afterAll(stopHttp);

describe('POST /spaces/:id/reps by email', () => {
  it("adds any Duevy account as a co-rep (and member), but not a guest or an unknown email", async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/reps`;
    const stamp = Date.now();

    const outsider = await db.user.create({ data: { name: 'Bola Ade', email: `bola_${stamp}@example.com`, passwordHash: 'x' } });
    const added = await api('POST', base, { token, body: { email: `  BOLA_${stamp}@example.com ` } });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ id: outsider.id, role: 'co' });
    expect(await db.spaceMembership.count({ where: { userId: outsider.id, spaceId: space.id } })).toBe(1);

    const again = await api('POST', base, { token, body: { email: outsider.email } });
    expect(again.status).toBe(409);

    const guest = await db.user.create({ data: { name: 'Guest Payer', email: `guest_${stamp}@example.com`, isGuest: true } });
    const asGuest = await api('POST', base, { token, body: { email: guest.email } });
    expect(asGuest.status).toBe(404);
    expect(asGuest.body.error.code).toBe('NO_ACCOUNT');

    const unknown = await api('POST', base, { token, body: { email: `nobody_${stamp}@example.com` } });
    expect(unknown.body.error.code).toBe('NO_ACCOUNT');
  });
});

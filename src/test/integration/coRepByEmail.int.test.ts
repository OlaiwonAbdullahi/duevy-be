import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../../lib/password';
import { db } from '../../config/db';
import { api, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendCoRepTempPasswordEmail: vi.fn(async () => {}),
}));
import { sendCoRepTempPasswordEmail } from '../../lib/email';

beforeAll(async () => {
  await startHttp();
});
afterAll(stopHttp);

describe('POST /spaces/:id/reps by email', () => {
  it('adds an existing Duevy account as a co-rep (and member), password untouched', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/reps`;
    const stamp = Date.now();

    const outsider = await db.user.create({ data: { name: 'Bola Ade', email: `bola_${stamp}@example.com`, passwordHash: 'x' } });
    vi.mocked(sendCoRepTempPasswordEmail).mockClear();

    const added = await api('POST', base, { token, body: { email: `  BOLA_${stamp}@example.com ` } });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ id: outsider.id, role: 'co', accountCreated: false, activated: false });
    expect(await db.spaceMembership.count({ where: { userId: outsider.id, spaceId: space.id } })).toBe(1);
    // A full account keeps its own password; no temp-password email goes out.
    expect((await db.user.findUniqueOrThrow({ where: { id: outsider.id } })).passwordHash).toBe('x');
    expect(sendCoRepTempPasswordEmail).not.toHaveBeenCalled();

    const again = await api('POST', base, { token, body: { email: outsider.email } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REP');
  });

  it('creates a co-rep account with a one-time password for an unknown email', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/reps`;
    const email = `nobody_${Date.now()}@example.com`;
    vi.mocked(sendCoRepTempPasswordEmail).mockClear();

    const res = await api('POST', base, { token, body: { email } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email, role: 'co', accountCreated: true, activated: true });
    // Never return the password in the API response.
    expect(res.body.data.tempPassword).toBeUndefined();
    expect(res.body.data.passwordHash).toBeUndefined();

    const user = await db.user.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(user).toMatchObject({ role: 'rep', isRep: true, repApplicationStatus: 'approved', isGuest: false });
    expect(user.passwordHash).toBeTruthy();
    expect(await db.spaceRep.findUniqueOrThrow({ where: { userId_spaceId: { userId: user.id, spaceId: space.id } } })).toMatchObject({ role: 'co' });

    // The temp password was emailed to the invited address, and it's the one we hashed.
    expect(sendCoRepTempPasswordEmail).toHaveBeenCalledTimes(1);
    const [to, , opts] = vi.mocked(sendCoRepTempPasswordEmail).mock.calls[0]!;
    expect(to).toBe(email);
    expect(opts.tempPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(await verifyPassword(opts.tempPassword, user.passwordHash!)).toBe(true);
  });

  it('activates a guest pay-link account into a co-rep with a one-time password', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/reps`;
    const guest = await db.user.create({ data: { name: 'Guest Payer', email: `guest_${Date.now()}@example.com`, isGuest: true } });
    vi.mocked(sendCoRepTempPasswordEmail).mockClear();

    const res = await api('POST', base, { token, body: { email: guest.email } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: guest.id, role: 'co', accountCreated: false, activated: true });

    const user = await db.user.findUniqueOrThrow({ where: { id: guest.id } });
    expect(user).toMatchObject({ isGuest: false, isRep: true, role: 'rep' });
    expect(user.passwordHash).toBeTruthy();
    expect(sendCoRepTempPasswordEmail).toHaveBeenCalledTimes(1);
  });

  it('uses an optional name for a new account, else derives one from the email', async () => {
    const { rep, space } = await makeSpace();
    const token = await tokenFor(rep);
    const base = `/v1/spaces/${space.id}/reps`;
    const stamp = Date.now();

    const named = await api('POST', base, { token, body: { email: `named_${stamp}@example.com`, name: 'Ada Lovelace' } });
    expect(named.body.data.name).toBe('Ada Lovelace');

    const derived = await api('POST', base, { token, body: { email: `tunde.bello@derived${stamp}.com` } });
    expect(derived.body.data.name).toBe('Tunde Bello'); // local part, separators → spaces, title-cased
  });
});

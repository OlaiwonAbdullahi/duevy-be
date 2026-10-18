import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { createTokens } from '../../services/auth.service';
import { api, makeSpace, startHttp, stopHttp } from './fixtures';

beforeAll(startHttp);
afterAll(stopHttp);

const cookie = (token: string) => ({ Cookie: `refreshToken=${token}` });

describe('POST /auth/refresh', () => {
  it('rotates the token and returns the same user GET /auth/me does', async () => {
    const { rep, space } = await makeSpace({ members: 0 });
    const { refreshToken } = await createTokens(rep.id, rep.role, [space.id]);

    const res = await api('POST', '/v1/auth/refresh', { headers: cookie(refreshToken) });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();

    const me = await api('GET', '/v1/auth/me', { token: res.body.data.accessToken });
    expect(me.status).toBe(200);
    expect(res.body.data.user).toEqual(me.body.data);
    expect(res.body.data.user.spaces.map((s: { id: string }) => s.id)).toContain(space.id);
    expect(res.body.data.user).not.toHaveProperty('isSuspended');
  });

  it('treats a replayed token as stolen and ends every session', async () => {
    const { rep, space } = await makeSpace({ members: 0 });
    const { refreshToken } = await createTokens(rep.id, rep.role, [space.id]);

    expect((await api('POST', '/v1/auth/refresh', { headers: cookie(refreshToken) })).status).toBe(200);
    expect(await db.refreshToken.count({ where: { userId: rep.id, revokedAt: null } })).toBe(1);

    const replay = await api('POST', '/v1/auth/refresh', { headers: cookie(refreshToken) });
    expect(replay.status).toBe(401);
    expect(await db.refreshToken.count({ where: { userId: rep.id, revokedAt: null } })).toBe(0);
  });

  it('refuses a suspended account', async () => {
    const { rep, space } = await makeSpace({ members: 0 });
    const { refreshToken } = await createTokens(rep.id, rep.role, [space.id]);
    await db.user.update({ where: { id: rep.id }, data: { isSuspended: true } });

    const res = await api('POST', '/v1/auth/refresh', { headers: cookie(refreshToken) });
    expect(res.status).toBe(401);
    expect(await db.refreshToken.count({ where: { userId: rep.id, revokedAt: null } })).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { db } from '../../config/db';
import { env } from '../../config/env';
import { MemoryPublicImageStore, setPublicImageStore, type PublicImageStore } from '../../lib/storage';
import { migrateUploads } from '../../scripts/migrateUploads';
import { api, apiMultipart, installFakeProvider, makeSpace, PNG_BYTES, startHttp, stopHttp, tokenFor } from './fixtures';

const store = new MemoryPublicImageStore();

beforeAll(async () => {
  installFakeProvider();
  setPublicImageStore(store);
  await startHttp();
});
afterAll(async () => {
  setPublicImageStore(null);
  await stopHttp();
});

const png = { bytes: PNG_BYTES, name: 'me.png', type: 'image/png' };

describe('avatars live in ImageKit, not on the container disk', () => {
  it('uploads to the public image store, replaces (and deletes) the previous one, and keeps it when a form echoes the URL', async () => {
    const { students } = await makeSpace();
    const user = students[0]!;
    const token = await tokenFor(user);

    const first = await apiMultipart('/v1/me/avatar', { token, files: { file: png } });
    expect(first.status).toBe(200);
    expect(first.body.data.avatarUrl).toMatch(/^https:\/\/images\.memory\.invalid\/avatars\//);
    const row1 = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row1.avatarUrl).toBe(first.body.data.avatarUrl);
    expect(store.files.has(row1.avatarFileId!)).toBe(true);

    const second = await apiMultipart('/v1/me/avatar', { token, files: { file: png } });
    const row2 = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row2.avatarUrl).toBe(second.body.data.avatarUrl);
    expect(row2.avatarFileId).not.toBe(row1.avatarFileId);
    await expect.poll(() => store.files.has(row1.avatarFileId!)).toBe(false); // the replaced file is deleted
    expect(store.files.has(row2.avatarFileId!)).toBe(true);

    // A profile form sending the same URL back changes nothing.
    expect((await api('PATCH', '/v1/me', { token, body: { name: 'Same Avatar', avatarUrl: row2.avatarUrl } })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).avatarFileId).toBe(row2.avatarFileId);
    expect(store.files.has(row2.avatarFileId!)).toBe(true);

    // A different URL lets go of the uploaded file.
    expect((await api('PATCH', '/v1/me', { token, body: { avatarUrl: 'https://example.com/me.png' } })).status).toBe(200);
    const row3 = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row3).toMatchObject({ avatarUrl: 'https://example.com/me.png', avatarFileId: null });
    await expect.poll(() => store.files.has(row2.avatarFileId!)).toBe(false);
  });

  it('refuses a non-image, and leaves the profile untouched when ImageKit is down', async () => {
    const { students } = await makeSpace();
    const user = students[0]!;
    const token = await tokenFor(user);

    const notImage = await apiMultipart('/v1/me/avatar', { token, files: { file: { bytes: Buffer.alloc(64, 7), name: 'x.png', type: 'image/png' } } });
    expect(notImage.status).toBe(400);

    const down: PublicImageStore = { name: 'down', upload: async () => { throw new Error('ImageKit 503'); }, delete: async () => {} };
    setPublicImageStore(down);
    try {
      const res = await apiMultipart('/v1/me/avatar', { token, files: { file: png } });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPLOAD_FAILED');
    } finally {
      setPublicImageStore(store);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).avatarUrl).toBeNull();
  });
});

describe('moving existing local uploads to ImageKit', () => {
  it('dry-runs without writing, then moves files and rewrites rows once; missing files are left alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'duevy-uploads-'));
    try {
      mkdirSync(path.join(dir, 'avatars'));
      const present = `${'a'.repeat(32)}.png`;
      writeFileSync(path.join(dir, 'avatars', present), PNG_BYTES);
      const { students } = await makeSpace({ members: 2 });
      const [withFile, missing] = students;
      const legacy = (name: string) => `${env.APP_BASE_URL}/uploads/avatars/${name}`;
      await db.user.update({ where: { id: withFile!.id }, data: { avatarUrl: legacy(present) } });
      await db.user.update({ where: { id: missing!.id }, data: { avatarUrl: legacy(`${'b'.repeat(32)}.png`) } });
      const quiet = () => {};

      const dry = await migrateUploads({ apply: false, uploadsDir: dir, log: quiet });
      expect(dry.avatars).toBeGreaterThanOrEqual(1);
      expect((await db.user.findUniqueOrThrow({ where: { id: withFile!.id } })).avatarUrl).toBe(legacy(present));

      const sizeBefore = store.files.size;
      await migrateUploads({ apply: true, uploadsDir: dir, log: quiet });
      const moved = await db.user.findUniqueOrThrow({ where: { id: withFile!.id } });
      expect(moved.avatarUrl).toMatch(/^https:\/\/images\.memory\.invalid\/avatars\//);
      expect(store.files.has(moved.avatarFileId!)).toBe(true);
      expect((await db.user.findUniqueOrThrow({ where: { id: missing!.id } })).avatarUrl).toBe(legacy(`${'b'.repeat(32)}.png`));

      // Re-running uploads nothing new for rows already moved.
      const sizeAfter = store.files.size;
      expect(sizeAfter).toBeGreaterThan(sizeBefore);
      await migrateUploads({ apply: true, uploadsDir: dir, log: quiet });
      expect(store.files.size).toBe(sizeAfter);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('guest pay link limits (a class on one campus IP)', () => {
  it('serves the link to a whole class from one address', async () => {
    const { dues } = await makeSpace();
    const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
    // The old shared join-code limiter stopped this at 10 a minute.
    const views = await Promise.all(Array.from({ length: 40 }, () => api('GET', `/v1/public/dues/${due.id}`)));
    expect(views.filter((v) => v.status === 200)).toHaveLength(40);
  });

  it('lets many classmates start paying from one address, but still holds one person to 10 a minute', async () => {
    const { dues } = await makeSpace({ dues: Array.from({ length: 12 }, () => 100_000) });
    const open = await Promise.all(dues.map((d) => db.due.update({ where: { id: d.id }, data: { allowGuests: true } })));
    const run = Date.now();

    // 12 different classmates, same network: all get through (the old per-IP 10/min refused the 11th).
    const classmates = await Promise.all(
      open.map((d, i) => api('POST', `/v1/public/dues/${d.id}/checkout`, { body: { name: `Mate ${i}`, matricNo: `CSC/${i}`, email: `mate${i}_${run}@test.duevy` } })),
    );
    expect(classmates.map((r) => r.status).every((s) => s === 201)).toBe(true);

    // One person hammering: the 11th attempt in a minute is refused.
    const email = `same_${run}@test.duevy`;
    const attempts = [];
    for (let i = 0; i < 11; i++) attempts.push((await api('POST', `/v1/public/dues/${open[i]!.id}/checkout`, { body: { name: 'Same Person', matricNo: 'CSC/1', email } })).status);
    expect(attempts.slice(0, 10).every((s) => s === 201 || s === 409)).toBe(true);
    expect(attempts[10]).toBe(429);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { cached, clearLocalCache, invalidate } from './cache';

describe('cached (no Redis)', () => {
  beforeEach(clearLocalCache);

  it('computes once per TTL, and once for concurrent misses', async () => {
    let runs = 0;
    const compute = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { total: 42, at: new Date('2026-01-01T00:00:00Z') };
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => cached('t1', 60_000, compute)));
    expect(runs).toBe(1);
    // A hit and a miss return the same JSON shape (Dates as ISO strings).
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify({ total: 42, at: '2026-01-01T00:00:00.000Z' }))).toBe(true);
    await cached('t1', 60_000, compute);
    expect(runs).toBe(1);
  });

  it('recomputes after expiry or invalidation, and never caches a failure', async () => {
    let n = 0;
    expect(await cached('t2', 1, async () => ++n)).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await cached('t2', 60_000, async () => ++n)).toBe(2);
    await invalidate('t2');
    expect(await cached('t2', 60_000, async () => ++n)).toBe(3);
    await expect(cached('t3', 60_000, async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await cached('t3', 60_000, async () => 'ok')).toBe('ok');
  });
});

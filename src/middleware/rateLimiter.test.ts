import { describe, expect, it } from 'vitest';
import { type RedisStore } from 'rate-limit-redis';
import { failOpen } from './rateLimiter';

const broken = {
  prefix: 'rl:test:',
  init: () => {},
  increment: async () => { throw new Error('redis not ready'); },
  decrement: async () => { throw new Error('redis not ready'); },
  resetKey: async () => { throw new Error('redis not ready'); },
} as unknown as RedisStore;

describe('rate-limit store when Redis fails', () => {
  it('lets the request through instead of erroring', async () => {
    const store = failOpen(broken);
    store.init?.({ windowMs: 60_000 } as never);
    const hit = await store.increment('1.2.3.4');
    expect(hit.totalHits).toBe(1);
    expect(hit.resetTime!.getTime()).toBeGreaterThan(Date.now());
    await expect(store.decrement('1.2.3.4')).resolves.toBeUndefined();
    await expect(store.resetKey('1.2.3.4')).resolves.toBeUndefined();
  });

  it('passes counts through when Redis works', async () => {
    const working = { ...broken, increment: async () => ({ totalHits: 7, resetTime: new Date() }) } as unknown as RedisStore;
    expect((await failOpen(working).increment('k')).totalHits).toBe(7);
  });
});

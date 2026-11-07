import { getRedis } from './redis';
import { logger } from './logger';

/**
 * Short-lived read-through cache for expensive, platform-wide READ views
 * (e.g. the admin overview), never for anything a money decision reads.
 *
 * Stored in Redis when it's connected, so every API instance shares one copy
 * and one computation per TTL; otherwise in this process. Concurrent misses
 * in a process share one computation (no stampede). A Redis failure only
 * means computing it here: the cache is never required to answer.
 *
 * Values go through JSON, so return plain data (numbers, strings, arrays,
 * objects); a Date comes back as an ISO string.
 */

const local = new Map<string, { value: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const fullKey = `cache:${key}`;
  const hit = local.get(fullKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const redis = getRedis();
  if (redis?.status === 'ready') {
    try {
      const raw = await redis.get(fullKey);
      if (raw !== null) {
        const value = JSON.parse(raw) as T;
        local.set(fullKey, { value, expiresAt: Date.now() + Math.min(ttlMs, 5_000) });
        return value;
      }
    } catch (err) {
      logger.debug({ key, err: (err as Error).message }, 'cache read failed; computing');
    }
  }

  const pending = inflight.get(fullKey);
  if (pending) return pending as Promise<T>;
  const run = (async () => {
    const value = await compute();
    // Round-trip through JSON so a hit and a miss return the same shape.
    const json = JSON.stringify(value);
    const plain = JSON.parse(json) as T;
    local.set(fullKey, { value: plain, expiresAt: Date.now() + ttlMs });
    if (redis?.status === 'ready') {
      redis.set(fullKey, json, 'PX', ttlMs).catch(() => {});
    }
    return plain;
  })().finally(() => inflight.delete(fullKey));
  inflight.set(fullKey, run);
  return run;
}

/** Drop a cached view (e.g. after an admin action it summarises). */
export async function invalidate(key: string): Promise<void> {
  const fullKey = `cache:${key}`;
  local.delete(fullKey);
  const redis = getRedis();
  if (redis?.status === 'ready') await redis.del(fullKey).catch(() => {});
}

/** Tests. */
export function clearLocalCache(): void {
  local.clear();
  inflight.clear();
}

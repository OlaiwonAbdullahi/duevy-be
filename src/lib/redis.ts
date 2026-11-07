import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Shared Redis connection (REDIS_URL). Holds state that must be the same on
 * every API instance — today, the rate-limit counters. Unset (tests, local
 * development) means per-process state, as before.
 *
 * Redis is never on the money path: if it is unreachable, rate limits fail
 * OPEN (requests pass, an error is logged) rather than turning a Redis blip
 * into a payments outage. While disconnected, limiter commands fail at once
 * (no added latency); a connected-but-stuck Redis times out after 300 ms. The
 * client keeps reconnecting in the background.
 */

let client: Redis | null | undefined;
let lastErrorLogAt = 0;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  if (!env.REDIS_URL) {
    client = null;
    return client;
  }
  client = new Redis(env.REDIS_URL, {
    // A connected-but-stuck Redis: give up quickly (the limiter may retry once).
    commandTimeout: 300,
    connectTimeout: 2_000,
    // Queue briefly while (re)connecting, then fail queued commands after one
    // reconnect attempt instead of holding requests indefinitely.
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  client.on('error', (err) => {
    // A down Redis errors on every reconnect attempt; log once a minute.
    if (Date.now() - lastErrorLogAt > 60_000) {
      lastErrorLogAt = Date.now();
      logger.error({ err: err.message }, 'redis unavailable: rate limits are failing open');
    }
  });
  client.on('ready', () => logger.info('redis connected'));
  return client;
}

/** For GET /health/ready: reported, never fatal (limits fail open without it). */
export async function redisStatus(): Promise<'ok' | 'down' | 'disabled'> {
  const r = getRedis();
  if (!r) return 'disabled';
  try {
    return (await r.ping()) === 'PONG' ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

export async function closeRedis(): Promise<void> {
  if (client) await client.quit().catch(() => client?.disconnect());
  client = undefined;
}

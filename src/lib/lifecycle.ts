import { type Server } from 'http';
import { db } from '../config/db';
import { logger } from './logger';
import { closeRedis } from './redis';
import { stopWebhookWorker } from '../jobs/webhookWorker';
import { reconciliationIdle } from '../jobs/reconciliation';
import { stopKycReminderJob } from '../jobs/kycReminders';

/**
 * Process lifecycle shared by the API (src/server.ts) and the standalone
 * worker (src/worker.ts).
 *
 * On SIGTERM (a deploy, a scale-down) the process stops taking new work and
 * lets the work in flight finish before it disconnects: HTTP requests already
 * received, a webhook batch, a reconciliation pass. Killing those mid-flight
 * was safe for money (every write is transactional, every provider call
 * idempotent by reference) but turned in-progress requests into 502s and left
 * webhook rows for the stale-lock reclaim. The deadline sits under the
 * container's stop grace period (docker-compose.yml: 30s), so the process
 * always gets to exit on its own terms.
 */

export const SHUTDOWN_DEADLINE_MS = 25_000;

let shuttingDown = false;

/** True once shutdown has begun; GET /health/ready then answers 503 so a load balancer drains this instance. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function installShutdownHandlers(opts: { server?: Server; timers: NodeJS.Timeout[] }): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining in-flight work');

    const deadline = setTimeout(() => {
      logger.error({ deadlineMs: SHUTDOWN_DEADLINE_MS }, 'graceful shutdown deadline passed; exiting with work in flight');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    opts.timers.forEach(clearInterval);
    const closeServer = opts.server
      ? new Promise<void>((resolve) => {
          // Stops accepting connections, closes idle keep-alive sockets, and
          // calls back once every in-flight request has been answered.
          opts.server!.close(() => resolve());
          opts.server!.closeIdleConnections();
        })
      : Promise.resolve();

    const results = await Promise.allSettled([closeServer, stopWebhookWorker(), reconciliationIdle(), stopKycReminderJob()]);
    for (const r of results) if (r.status === 'rejected') logger.warn({ err: (r.reason as Error)?.message }, 'error while draining');

    await closeRedis();
    await db.$disconnect().catch(() => {});
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

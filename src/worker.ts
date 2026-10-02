import { db } from './config/db';
import { logger } from './lib/logger';
import { startReconciliationJob } from './jobs/reconciliation';
import { startWebhookWorker } from './jobs/webhookWorker';

/**
 * Standalone worker: the webhook queue and the reconciliation sweep, without
 * the HTTP server. Run alongside API processes started with RUN_WORKERS=false.
 * Safe to run several: claims use FOR UPDATE SKIP LOCKED and every handler is
 * idempotent.
 */
async function main() {
  await db.$connect();
  const timers = [startWebhookWorker(), startReconciliationJob()];
  logger.info('worker started');

  const shutdown = async () => {
    timers.forEach(clearInterval);
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

import { db } from './config/db';
import { logger } from './lib/logger';
import { startReconciliationJob } from './jobs/reconciliation';
import { startWebhookWorker } from './jobs/webhookWorker';
import { startKycReminderJob } from './jobs/kycReminders';
import { installShutdownHandlers } from './lib/lifecycle';

/**
 * Standalone worker: the webhook queue, the reconciliation sweep and the KYC
 * reminder emails, without the HTTP server. Run alongside API processes
 * started with RUN_WORKERS=false.
 * Safe to run several: claims use FOR UPDATE SKIP LOCKED and every handler is
 * idempotent.
 */
async function main() {
  await db.$connect();
  const timers = [startWebhookWorker(), startReconciliationJob(), startKycReminderJob()];
  logger.info('worker started');

  installShutdownHandlers({ timers });
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

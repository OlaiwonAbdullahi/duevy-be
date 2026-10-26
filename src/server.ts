import { app } from './app';
import { env } from './config/env';
import { db } from './config/db';
import { logger } from './lib/logger';
import { startReconciliationJob } from './jobs/reconciliation';
import { startWebhookWorker } from './jobs/webhookWorker';
import { startKycReminderJob } from './jobs/kycReminders';
import { getPaymentProvider } from './providers/payment';

async function startServer() {
  try {
    await db.$connect();
    logger.info({ provider: getPaymentProvider().name }, 'connected to database');

    const server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, 'server ready');
    });

    // The webhook queue worker and the reconciliation sweep run in-process by
    // default. Set RUN_WORKERS=false to run them separately (npm run worker).
    const timers = env.RUN_WORKERS ? [startWebhookWorker(), startReconciliationJob(), startKycReminderJob()] : [];

    const shutdown = async () => {
      logger.info('shutting down');
      timers.forEach(clearInterval);
      server.close();
      await db.$disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // A stray rejected promise would otherwise kill the whole API (Node's
    // default); log it and keep serving. A thrown exception leaves the process
    // in an unknown state, so log and exit — Docker restarts the container.
    process.on('unhandledRejection', (reason) => {
      logger.error({ err: reason }, 'unhandled promise rejection');
    });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  } catch (err) {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
}

startServer();

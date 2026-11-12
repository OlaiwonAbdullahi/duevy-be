import { app } from './app';
import { env } from './config/env';
import { db } from './config/db';
import { logger } from './lib/logger';
import { startReconciliationJob } from './jobs/reconciliation';
import { startWebhookWorker } from './jobs/webhookWorker';
import { startKycReminderJob } from './jobs/kycReminders';
import { startMilestoneJob } from './jobs/milestones';
import { getPaymentProvider } from './providers/payment';
import { installShutdownHandlers } from './lib/lifecycle';

async function startServer() {
  try {
    await db.$connect();
    logger.info({ provider: getPaymentProvider().name }, 'connected to database');
    // Prisma behind a transaction pooler (pgbouncer=true) wraps every query in
    // its own transaction with an unnamed statement: ~5 round trips per query
    // instead of 1. Measured: a dashboard page at 60 ms from the database took
    // ~320 ms instead of ~68 ms. A long-running server should use the session
    // pooler (Supabase port 5432) or a direct connection. docs/SCALING.md §3.11.
    if (/[?&]pgbouncer=true\b/.test(env.DATABASE_URL)) {
      logger.warn('DATABASE_URL uses pgbouncer=true (transaction pooler): every query costs ~5 database round trips. Use the session pooler (port 5432) or a direct connection.');
    }
    if (!env.REDIS_URL && env.NODE_ENV === 'production') {
      logger.warn('REDIS_URL is not set: rate limits are per process, so they loosen with every extra instance');
    }

    const server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, 'server ready');
    });
    // Caddy (and most proxies) keep upstream connections idle for up to 2
    // minutes. Node's default 5s keep-alive closed them first, so a request
    // sent on a socket Node was closing came back as a sporadic 502. Outlive
    // the proxy instead; headersTimeout must exceed keepAliveTimeout.
    server.keepAliveTimeout = 125_000;
    server.headersTimeout = 126_000;
    // Upper bound for receiving a whole request (slow mobile uploads included).
    server.requestTimeout = 120_000;

    // The webhook queue worker and the reconciliation sweep run in-process by
    // default. Set RUN_WORKERS=false to run them separately (npm run worker).
    const timers = env.RUN_WORKERS ? [startWebhookWorker(), startReconciliationJob(), startKycReminderJob(), startMilestoneJob()] : [];

    installShutdownHandlers({ server, timers });

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

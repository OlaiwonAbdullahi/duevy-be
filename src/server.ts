import { app } from './app';
import { env } from './config/env';
import { db } from './config/db';
import { startReconciliationJob } from './jobs/reconciliation';

async function startServer() {
  try {
    await db.$connect();
    console.log('✅ Connected to database');

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Server ready at http://localhost:${env.PORT}`);
    });

    const reconciliationJob = startReconciliationJob();

    // Graceful shutdown
    const shutdown = async () => {
      console.log('Shutting down server...');
      clearInterval(reconciliationJob);
      server.close();
      await db.$disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

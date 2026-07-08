import { app } from './app';
import { env } from './config/env';
import { db } from './config/db';

async function startServer() {
  try {
    await db.$connect();
    console.log('✅ Connected to database');

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Server ready at http://localhost:${env.PORT}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('Shutting down server...');
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

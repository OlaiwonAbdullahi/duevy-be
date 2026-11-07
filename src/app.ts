import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { pinoHttp } from 'pino-http';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { env } from './config/env';
import { apiRouter } from './routes';
import { webhooksRouter } from './routes/webhooks';
import { errorHandler } from './middleware/errorHandler';
import { standardLimiter } from './middleware/rateLimiter';
import { ok, fail } from './lib/response';
import { logger } from './lib/logger';
import { db } from './config/db';
import { isShuttingDown } from './lib/lifecycle';
import { redisStatus } from './lib/redis';

export const app = express();

// Behind Render's proxy req.ip must come from X-Forwarded-For, or every
// client shares one rate-limit bucket. Never trust it without a proxy.
app.set('trust proxy', env.TRUST_PROXY ?? (env.NODE_ENV === 'production' ? 1 : 0));
app.disable('x-powered-by');

// Security headers
app.use(helmet());

// gzip/brotli JSON responses — big lists (transactions, members) shrink ~80%.
app.use(compression());

// CORS
const allowedOrigins = env.CORS_ORIGINS.split(',').map(o => o.trim());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  // Let browsers cache the preflight (Chrome caps this at 2h) so authenticated
  // requests don't pay an extra OPTIONS round trip each time.
  maxAge: 7200,
}));

// Request parsing. Capture the raw body so the payment webhook can verify its
// HMAC signature over the exact bytes received.
app.use(
  express.json({
    limit: '100kb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(cookieParser());

// LEGACY: avatars and poll images saved before they moved to ImageKit (new
// uploads are served from its CDN). Remove this, and the uploads volume, once
// src/scripts/migrateUploads.ts has been run with --apply in production.
app.use(
  '/uploads',
  express.static('uploads', {
    dotfiles: 'deny',
    index: false,
    maxAge: '7d',
    setHeaders: (res) => {
      // User-supplied files: never let a browser run them as a page.
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }),
);

// Structured request logging. Bodies are never logged; sensitive headers are
// redacted by the logger (src/lib/logger.ts).
if (env.NODE_ENV !== 'test') {
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        // Only echo a client-supplied id if it looks like one (no log injection).
        const given = req.headers['x-request-id'];
        const id = typeof given === 'string' && /^[\w-]{1,64}$/.test(given) ? given : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health probes every few seconds would drown the request log.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/health/ready' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
}

// Provider webhooks are authenticated by signature and arrive from a few
// provider IPs in bursts, so they sit in front of the per-IP limiter — a busy
// collection day (or someone hammering the API) must never 429 payments.
app.use('/v1/webhooks', webhooksRouter);

// Global rate limit
app.use('/v1', standardLimiter);

// Liveness: the process is up and serving. Deliberately touches nothing
// else, so a database blip never gets a healthy container restarted.
app.get('/health', (req, res) => {
  ok(res, { status: 'healthy', timestamp: new Date().toISOString() });
});

// Readiness, for a load balancer: can this instance take traffic right now?
// 503 while shutting down (so it is drained before it exits) or when the
// database doesn't answer within 2s.
app.get('/health/ready', async (_req, res) => {
  if (isShuttingDown()) {
    fail(res, 503, 'SHUTTING_DOWN', 'This instance is shutting down');
    return;
  }
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('database ping timed out')), 2_000);
      }),
    ]);
    const dbLatencyMs = Date.now() - started;
    // Reported, not fatal: without Redis the rate limits fail open, and
    // draining every instance over it would turn a blip into an outage.
    ok(res, { status: 'ready', dbLatencyMs, redis: await redisStatus() });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'readiness check failed');
    fail(res, 503, 'NOT_READY', 'Database unavailable');
  } finally {
    clearTimeout(timer);
  }
});

// API Routes
app.use('/v1', apiRouter);

// 404 handler
app.use((req, res) => {
  fail(res, 404, 'NOT_FOUND', 'Route not found');
});

// Global error handler
app.use(errorHandler);

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

// Uploaded assets (avatars §3.2, nominee images §11)
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

// Health check
app.get('/health', (req, res) => {
  ok(res, { status: 'healthy', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/v1', apiRouter);

// 404 handler
app.use((req, res) => {
  fail(res, 404, 'NOT_FOUND', 'Route not found');
});

// Global error handler
app.use(errorHandler);

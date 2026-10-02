import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { pinoHttp } from 'pino-http';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiRouter } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { standardLimiter } from './middleware/rateLimiter';
import { ok, fail } from './lib/response';
import { logger } from './lib/logger';

export const app = express();

// Security headers
app.use(helmet());

// CORS
const allowedOrigins = env.CORS_ORIGINS.split(',').map(o => o.trim());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
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
app.use('/uploads', express.static('uploads'));

// Structured request logging. Bodies are never logged; sensitive headers are
// redacted by the logger (src/lib/logger.ts).
if (env.NODE_ENV !== 'test') {
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
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

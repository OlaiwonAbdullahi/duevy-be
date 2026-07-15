import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiRouter } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { standardLimiter } from './middleware/rateLimiter';
import { ok, fail } from './lib/response';

export const app = express();

// Security headers
app.use(helmet());

// CORS
const allowedOrigins = env.CORS_ORIGINS.split(',').map(o => o.trim());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Request parsing. Capture the raw body so the Monnify webhook (§15) can verify
// its HMAC signature over the exact bytes received.
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

// Logging
if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));
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

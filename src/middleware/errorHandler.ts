import { type Request, type Response, type NextFunction } from 'express';
import { fail } from '../lib/response';
import { env } from '../config/env';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  console.error('[error]', err);

  if (res.headersSent) {
    return next(err);
  }

  // Handle known error types (e.g., Prisma errors, Multer errors) here if needed

  const message =
    env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred';

  fail(res, 500, 'INTERNAL_ERROR', message);
}

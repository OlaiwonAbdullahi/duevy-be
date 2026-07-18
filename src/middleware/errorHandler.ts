import { type Request, type Response, type NextFunction } from 'express';
import { fail, errors, RequestValidationError } from '../lib/response';
import { env } from '../config/env';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    console.error('[error]', err);
    return next(err);
  }

  if (err instanceof RequestValidationError) {
    errors.validation(res, err.details);
    return;
  }

  console.error('[error]', err);

  // Handle other known error types (e.g., Prisma errors, Multer errors) here if needed

  const message =
    env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred';

  fail(res, 500, 'INTERNAL_ERROR', message);
}

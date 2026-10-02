import { type Request, type Response, type NextFunction } from 'express';
import { fail, errors, RequestValidationError } from '../lib/response';
import { AppError } from '../lib/errors';
import { ProviderError } from '../providers/payment';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    logger.error({ err, path: req.path }, 'error after headers were sent');
    return next(err);
  }

  if (err instanceof RequestValidationError) {
    errors.validation(res, err.details);
    return;
  }

  if (err instanceof AppError) {
    fail(res, err.status, err.code, err.message, err.details);
    return;
  }

  // A provider failure that reached the edge un-handled. The message is ours
  // or the provider's own `detail`, never a payload, so it is safe to return.
  if (err instanceof ProviderError) {
    logger.error({ code: err.code, status: err.status, requestId: err.requestId, path: req.path }, 'payment provider error');
    fail(res, 502, 'PROVIDER_ERROR', 'The payment provider could not complete this request. Please try again.');
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');

  const message =
    env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred';

  fail(res, 500, 'INTERNAL_ERROR', message);
}

import { type Response } from 'express';

export interface Meta {
  page?: number;
  perPage?: number;
  total?: number;
  totalPages?: number;
  unreadCount?: number;
  [key: string]: unknown;
}

/** Send a success envelope response. */
export function ok<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Meta,
): void {
  res.status(statusCode).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
  });
}

/** Send an error envelope response. */
export function fail(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
): void {
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

/** Common error helpers */
export const errors = {
  notFound: (res: Response, msg = 'Resource not found') =>
    fail(res, 404, 'NOT_FOUND', msg),

  unauthorized: (res: Response, msg = 'Authentication required') =>
    fail(res, 401, 'UNAUTHENTICATED', msg),

  tokenExpired: (res: Response) =>
    fail(res, 401, 'TOKEN_EXPIRED', 'Access token has expired'),

  forbidden: (res: Response, msg = 'Access denied') =>
    fail(res, 403, 'FORBIDDEN', msg),

  validation: (
    res: Response,
    details: Array<{ field: string; issue: string }>,
  ) => fail(res, 400, 'VALIDATION_ERROR', 'Request validation failed', details),

  conflict: (res: Response, code: string, msg: string) =>
    fail(res, 409, code, msg),

  internal: (res: Response) =>
    fail(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred'),
};

/**
 * A domain error with an HTTP status and a stable machine-readable code.
 * Services throw these; errorHandler.ts renders them in the standard error
 * envelope, so routes don't need a try/catch per failure mode.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ field: string; issue: string }>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
export const forbidden = (message = 'Access denied', code = 'FORBIDDEN') => new AppError(403, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unprocessable = (code: string, message: string) => new AppError(422, code, message);

import { type Request, type Response, type NextFunction } from 'express';
import { type AuthenticatedRequest } from './auth';
import { db } from '../config/db';
import { fail } from '../lib/response';

/**
 * Idempotency middleware for money-moving POST endpoints.
 *
 * If the Idempotency-Key header is present:
 *  - Hit: returns the stored response without re-processing.
 *  - Miss: stores the response after the handler completes.
 *
 * Keys are retained for 24 hours per the spec (§1.8).
 */
export function idempotent(req: Request, res: Response, next: NextFunction): void {
  const rawKey = req.headers['idempotency-key'];
  const key = typeof rawKey === 'string' ? rawKey : undefined;
  if (!key) {
    next();
    return;
  }

  const userId = (req as AuthenticatedRequest).user?.sub;
  if (!userId) {
    next();
    return;
  }

  // The stored key is scoped to the caller so one user's key can never replay
  // another user's response.
  const scopedKey = `${userId}:${key}`;

  db.idempotencyKey
    .findUnique({ where: { key: scopedKey } })
    .then((existing) => {
      if (existing) {
        // Replay the original response.
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }

      // Intercept res.json to capture and persist the response.
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown) {
        const status = res.statusCode;
        // Only cache successful (2xx) responses. Caching a transient 4xx/5xx
        // would replay the failure forever.
        if (status >= 200 && status < 300) {
          // Insert-first with the unique constraint as the race guard: if a
          // concurrent request already stored this key, the create rejects and
          // we simply skip — the response still goes out to this caller.
          db.idempotencyKey
            .create({
              data: {
                key: scopedKey,
                userId,
                responseStatus: status,
                responseBody: body as object,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              },
            })
            .catch((err) =>
              console.error('[idempotency] Failed to store key:', err),
            );
        }
        return originalJson(body);
      };

      next();
    })
    .catch((err) => {
      console.error('[idempotency] DB error:', err);
      // Don't block the request on idempotency errors.
      next();
    });
}

/** Require an Idempotency-Key header — used on money-moving endpoints. */
export function requireIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') {
    fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key header is required for this endpoint',
      [{ field: 'Idempotency-Key', issue: 'header is required' }],
    );
    return;
  }
  // Basic UUID v4 check
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(key)) {
    fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must be a UUID v4',
      [{ field: 'Idempotency-Key', issue: 'must be a valid UUID v4' }],
    );
    return;
  }
  next();
}

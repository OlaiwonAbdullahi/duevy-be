import { createHash } from 'crypto';
import { type Request, type Response, type NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { type AuthenticatedRequest } from './auth';
import { db } from '../config/db';
import { fail } from '../lib/response';
import { logger } from '../lib/logger';

/**
 * Idempotency for state-changing payment endpoints (Idempotency-Key header).
 *
 *  - The key is CLAIMED before the handler runs (insert with status 0). A
 *    concurrent duplicate hits the unique index and gets 409
 *    IDEMPOTENCY_IN_PROGRESS — the handler never runs twice at once.
 *  - The key is bound to a fingerprint of the request (method, path, body).
 *    Reusing it for a different request is a 422, never a silent replay.
 *  - A 2xx response is stored and replayed for 24h. Anything else releases
 *    the claim so the client may retry with the same key.
 *
 * Keys are scoped per user, so one user's key can never replay another's.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS = 0;

function fingerprint(req: Request): string {
  return createHash('sha256')
    .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? null)}`)
    .digest('hex');
}

/** Insert-if-absent; the unique key is the race guard. True if this request won the claim. */
async function claim(scopedKey: string, userId: string, requestHash: string): Promise<boolean> {
  const { count } = await db.idempotencyKey.createMany({
    data: [{ key: scopedKey, userId, requestHash, responseStatus: IN_PROGRESS, expiresAt: new Date(Date.now() + TTL_MS) }],
    skipDuplicates: true,
  });
  return count === 1;
}

export function idempotent(req: Request, res: Response, next: NextFunction): void {
  const rawKey = req.headers['idempotency-key'];
  const key = typeof rawKey === 'string' ? rawKey : undefined;
  const userId = (req as AuthenticatedRequest).user?.sub;
  if (!key || !userId) {
    next();
    return;
  }

  const scopedKey = `${userId}:${key}`;
  const requestHash = fingerprint(req);

  (async () => {
    let claimed = await claim(scopedKey, userId, requestHash);
    if (!claimed) {
      const existing = await db.idempotencyKey.findUnique({ where: { key: scopedKey } });
      if (existing && existing.expiresAt < new Date()) {
        await db.idempotencyKey.delete({ where: { key: scopedKey } }).catch(() => {});
        claimed = await claim(scopedKey, userId, requestHash);
      } else if (existing) {
        if (existing.requestHash && existing.requestHash !== requestHash) {
          fail(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
          return;
        }
        if (existing.responseStatus === IN_PROGRESS) {
          fail(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
          return;
        }
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      } else {
        claimed = await claim(scopedKey, userId, requestHash);
      }
      if (!claimed) {
        fail(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
        return;
      }
    }

    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      db.idempotencyKey.deleteMany({ where: { key: scopedKey, responseStatus: IN_PROGRESS } }).catch(() => {});
    };

    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      const status = res.statusCode;
      if (status >= 200 && status < 300 && !settled) {
        settled = true;
        db.idempotencyKey
          .update({ where: { key: scopedKey }, data: { responseStatus: status, responseBody: body as Prisma.InputJsonValue } })
          .catch((err) => logger.error({ err: (err as Error).message }, 'failed to store idempotent response'));
      } else {
        release();
      }
      return originalJson(body);
    };
    // Handler ended without a JSON body (or the client went away): release.
    res.on('close', release);

    next();
  })().catch((err) => {
    logger.error({ err: (err as Error).message }, 'idempotency store unavailable');
    // Fail closed: on a money endpoint, running without the guarantee is worse.
    fail(res, 503, 'IDEMPOTENCY_UNAVAILABLE', 'Please retry this request shortly');
  });
}

/** Require an Idempotency-Key header (UUID v4) on money-moving endpoints. */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') {
    fail(res, 400, 'VALIDATION_ERROR', 'Idempotency-Key header is required for this endpoint', [
      { field: 'Idempotency-Key', issue: 'header is required' },
    ]);
    return;
  }
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(key)) {
    fail(res, 400, 'VALIDATION_ERROR', 'Idempotency-Key must be a UUID v4', [
      { field: 'Idempotency-Key', issue: 'must be a valid UUID v4' },
    ]);
    return;
  }
  next();
}

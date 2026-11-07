import { db } from '../config/db';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { processEvent, type StoredEventPayload } from '../services/webhookProcessor.service';

/**
 * DB-backed job queue for inbound webhook events (no Redis required).
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so any number of API/worker processes
 * can run this loop against the same table without double-processing. A row
 * whose worker died mid-flight (status `processing`, stale lockedAt) is
 * reclaimed. Failures retry with exponential backoff; after MAX_ATTEMPTS the
 * row is `dead` and surfaces on GET /admin/health.
 *
 * Retries are always safe because every handler is idempotent.
 */

export const MAX_ATTEMPTS = 8;
const BATCH = 10;
const STALE_LOCK_MS = 5 * 60 * 1000;

/** 10s, 20s, 40s … capped at 1h. */
export function backoffMs(attempt: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);
}

interface ClaimedRow {
  id: string;
  providerEventId: string;
  type: string;
  attempts: number;
  payload: StoredEventPayload;
}

async function claimBatch(): Promise<ClaimedRow[]> {
  // Timestamps are passed from here, never NOW(): the columns are UTC
  // timestamp(3) (no zone) and both NOW() and a bound Date are read in the
  // session time zone unless converted with AT TIME ZONE 'UTC'.
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  return db.$queryRaw<ClaimedRow[]>`
    UPDATE "webhook_events" SET "status" = 'processing', "lockedAt" = (${now}::timestamptz AT TIME ZONE 'UTC'), "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "webhook_events"
      WHERE ("status" IN ('received', 'failed') AND "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC'))
         OR ("status" = 'processing' AND "lockedAt" < (${staleBefore}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "receivedAt"
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "providerEventId", "type", "attempts", "payload"`;
}

async function runOne(row: ClaimedRow): Promise<void> {
  try {
    await processEvent(row.payload.event);
    await db.webhookEvent.update({
      where: { id: row.id },
      data: { status: 'processed', processedAt: new Date(), lockedAt: null, error: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const dead = row.attempts >= MAX_ATTEMPTS;
    await db.webhookEvent.update({
      where: { id: row.id },
      data: {
        status: dead ? 'dead' : 'failed',
        lockedAt: null,
        error: message.slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
      },
    });
    const log = { eventId: row.providerEventId, type: row.type, attempt: row.attempts, err: message };
    if (dead) logger.error(log, 'webhook event dead-lettered');
    else logger.warn(log, 'webhook event failed — will retry');
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Every handler makes a
 * provider round trip (up to its 20s timeout), so one-at-a-time capped a
 * process at a few events per second and a payment burst queued for minutes.
 * Running a claimed batch concurrently is safe for the same reasons several
 * worker processes are: every handler row-locks or claims conditionally, and
 * the ledger/provider-transaction unique keys stop a double outcome.
 */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(lanes);
}

/** Process everything currently due. Returns how many events were handled. */
export async function drainWebhookQueue(maxBatches = 20, concurrency = env.WEBHOOK_WORKER_CONCURRENCY): Promise<number> {
  let handled = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await claimBatch();
    if (rows.length === 0) break;
    // A handler failure is recorded on the row for retry. If even that write
    // fails (database gone), the row stays `processing` and is reclaimed
    // after STALE_LOCK_MS; the other events in the batch still run.
    await forEachLimit(rows, concurrency, (row) =>
      runOne(row).catch((err) => logger.error({ eventId: row.providerEventId, err: (err as Error).message }, 'webhook event outcome not recorded')),
    );
    handled += rows.length;
  }
  return handled;
}

let draining: Promise<number> | null = null;
let stopped = false;

/** Nudge the worker now (called right after a webhook is enqueued). Coalesces concurrent nudges. */
export function kickWebhookWorker(): void {
  if (draining || stopped) return;
  draining = drainWebhookQueue()
    .catch((err) => {
      logger.error({ err: (err as Error).message }, 'webhook drain failed');
      return 0;
    })
    .finally(() => {
      draining = null;
    });
}

/** Poll the queue on an interval. Returns a handle for shutdown. */
export function startWebhookWorker(intervalMs = 2_000): NodeJS.Timeout {
  stopped = false;
  return setInterval(kickWebhookWorker, intervalMs);
}

/** Shutdown: start no new drain, and resolve once the one in flight has finished. */
export async function stopWebhookWorker(): Promise<void> {
  stopped = true;
  await draining;
}

import { logger } from '../../../lib/logger';
import { ProviderError } from '../types';

/**
 * Thin fetch wrapper for the Bachs REST API.
 *
 *  - Authorization: Bearer <secret key>
 *  - X-Account-Id acts on behalf of a connected account (a rep).
 *  - Idempotency-Key on every money-moving POST, so a retried call after a
 *    timeout replays the original response instead of moving money twice.
 *  - Errors come back as { detail, error_code, errors? }; we branch on
 *    error_code, never on the human-readable detail.
 *
 * Request and response bodies are never logged: they carry BVNs, account
 * numbers and names. Only method, path, status, timing and Bachs's
 * x-request-id are.
 */

export interface BachsRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  accountId?: string | null;
  idempotencyKey?: string;
  /** Short label for logs, e.g. "payout.create". */
  op: string;
  /** Payment reference for log correlation. */
  ref?: string;
}

interface BachsErrorBody {
  detail?: string;
  error_code?: string;
  message?: string;
}

const TIMEOUT_MS = 20_000;

export class BachsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
  ) {}

  async request<T>(req: BachsRequest): Promise<T> {
    const url = new URL(req.path, this.baseUrl);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: 'application/json',
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (req.accountId) headers['X-Account-Id'] = req.accountId;
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ op: req.op, ref: req.ref, path: req.path, err: (err as Error).message }, 'bachs request did not complete');
      // A timeout is NOT proof the call failed; callers retry with the same key.
      throw new ProviderError(`Bachs ${req.op} did not complete: ${(err as Error).message}`, null, null, true);
    }

    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    const log = { op: req.op, ref: req.ref, path: req.path, status: res.status, ms: Date.now() - started, requestId };

    if (!res.ok) {
      let body: BachsErrorBody = {};
      try {
        body = JSON.parse(text) as BachsErrorBody;
      } catch {
        /* non-JSON error body */
      }
      const retryable = res.status === 429 || res.status >= 500 || body.error_code === 'IDEMPOTENCY_IN_PROGRESS';
      logger.warn({ ...log, code: body.error_code }, 'bachs request failed');
      throw new ProviderError(
        body.detail ?? body.message ?? `Bachs ${req.op} failed with ${res.status}`,
        res.status,
        body.error_code ?? null,
        retryable,
        requestId,
      );
    }

    logger.debug(log, 'bachs request ok');
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError(`Bachs ${req.op} returned a non-JSON body`, res.status, null, false, requestId);
    }
  }
}

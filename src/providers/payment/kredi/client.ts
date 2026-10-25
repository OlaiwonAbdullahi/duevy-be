import { logger } from '../../../lib/logger';
import { ProviderError } from '../types';

/**
 * Thin fetch wrapper for the Kredi Pay API (documentation.thekredibank.com).
 *
 *  - Two credentials on every call: `x-api-key` and `Authorization: Bearer
 *    <token>`, both from the dashboard. Generating a new token invalidates the
 *    old one, so the app never refreshes it itself.
 *  - No idempotency header. Money-moving calls carry our reference as
 *    `transaction_reference`, which Kredi refuses to reuse ("Duplicate
 *    transaction reference"), so a retry can't pay twice.
 *  - Kredi reports business errors either as an HTTP error or as HTTP 200 with
 *    `status: "Failed"`; both become a ProviderError.
 *
 * Request and response bodies are never logged: they carry BVNs, account
 * numbers and names. Only method, path, status and timing are.
 */

export interface KrediRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Short label for logs, e.g. "payout.create". */
  op: string;
  /** Payment reference for log correlation. */
  ref?: string;
}

/** Kredi's usual envelope. `status` is a number, "Success"/"Failed", or a boolean depending on the endpoint. */
export interface KrediEnvelope<T> {
  status?: number | string | boolean;
  message?: string;
  data?: T;
}

const TIMEOUT_MS = 20_000;

function failedBody(body: KrediEnvelope<unknown>): boolean {
  const s = body.status;
  if (s === false) return true;
  if (typeof s === 'string') return /^(failed|error|fail)$/i.test(s) || /^4\d\d$/.test(s);
  if (typeof s === 'number') return s >= 400;
  return false;
}

/** Machine-readable codes for the refusals callers branch on. */
function codeFor(message: string, httpStatus: number): string | null {
  if (/duplicate transaction reference/i.test(message)) return 'DUPLICATE_REFERENCE';
  if (/does not exist/i.test(message)) return 'NOT_FOUND';
  if (/insufficient/i.test(message)) return 'INSUFFICIENT_BALANCE';
  if (/access denied|forbidden|unauthori[sz]ed/i.test(message) || httpStatus === 401 || httpStatus === 403) return 'UNAUTHORIZED';
  return null;
}

export class KrediClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly authToken: string,
  ) {}

  async request<T>(req: KrediRequest): Promise<KrediEnvelope<T>> {
    const url = new URL(req.path, this.baseUrl);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      Authorization: `Bearer ${this.authToken}`,
      Accept: 'application/json',
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';

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
      logger.warn({ op: req.op, ref: req.ref, path: req.path, err: (err as Error).message }, 'kredi request did not complete');
      // A timeout is NOT proof the call failed; callers re-query by reference.
      throw new ProviderError(`Kredi ${req.op} did not complete: ${(err as Error).message}`, null, null, true);
    }

    const text = await res.text();
    const log = { op: req.op, ref: req.ref, path: req.path, status: res.status, ms: Date.now() - started };
    let body: KrediEnvelope<T> = {};
    let parsed = false;
    try {
      body = text ? (JSON.parse(text) as KrediEnvelope<T>) : {};
      parsed = true;
    } catch {
      /* non-JSON body */
    }

    if (!res.ok || (parsed && failedBody(body))) {
      const message = body.message ?? `Kredi ${req.op} failed with ${res.status}`;
      const code = codeFor(message, res.status);
      const retryable = res.status === 429 || res.status >= 500;
      logger.warn({ ...log, code, bodyStatus: typeof body.status === 'object' ? undefined : body.status }, 'kredi request failed');
      throw new ProviderError(message, res.ok ? 422 : res.status, code, retryable);
    }
    if (!parsed) throw new ProviderError(`Kredi ${req.op} returned a non-JSON body`, res.status, null, false);

    logger.debug(log, 'kredi request ok');
    return body;
  }
}

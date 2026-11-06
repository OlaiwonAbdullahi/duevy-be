import { logger } from '../../../lib/logger';
import { ProviderError } from '../types';

/**
 * Thin fetch wrapper for the 9jaPay Virtual Account API (docs.9japay.com).
 *
 *  - Every request carries the `api-key` and `secret` headers.
 *  - Responses are { status, message, statusCode, data }. `statusCode` is the
 *    machine-readable outcome ("00" success, "01" processing, "26" duplicate,
 *    "25" no record, "09" validation, "06" general error); we branch on it,
 *    never on the message.
 *  - There is no idempotency header: a duplicate reference is refused with
 *    "26", which callers treat as "already sent — ask for its status".
 *
 * Request and response bodies are never logged: they carry account numbers
 * and names. Only method, path, status, statusCode and timing are.
 */

export interface NineJaPayRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Short label for logs, e.g. "transfer.create". */
  op: string;
  /** Our reference, for log correlation. */
  ref?: string;
}

export interface NineJaPayEnvelope<T> {
  status?: string;
  message?: string;
  statusCode?: string;
  data?: T;
}

const TIMEOUT_MS = 20_000;

export class NineJaPayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly secretKey: string,
  ) {}

  async request<T>(req: NineJaPayRequest): Promise<NineJaPayEnvelope<T>> {
    const url = new URL(req.path, this.baseUrl);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      'api-key': this.apiKey,
      secret: this.secretKey,
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
      logger.warn({ op: req.op, ref: req.ref, path: req.path, err: (err as Error).message }, '9japay request did not complete');
      // A timeout is NOT proof the call failed; callers check status before retrying.
      throw new ProviderError(`9jaPay ${req.op} did not complete: ${(err as Error).message}`, null, null, true);
    }

    const text = await res.text();
    let body: NineJaPayEnvelope<T> = {};
    try {
      body = text ? (JSON.parse(text) as NineJaPayEnvelope<T>) : {};
    } catch {
      if (res.ok) throw new ProviderError(`9jaPay ${req.op} returned a non-JSON body`, res.status, null, false);
    }
    const log = { op: req.op, ref: req.ref, path: req.path, status: res.status, code: body.statusCode, ms: Date.now() - started };

    const failed = !res.ok || (body.status ?? '').toUpperCase() === 'FAILED';
    if (failed) {
      const retryable = res.status === 429 || res.status >= 500;
      logger.warn(log, '9japay request failed');
      throw new ProviderError(
        body.message ?? `9jaPay ${req.op} failed with ${res.status}`,
        res.status,
        codeName(body.statusCode),
        retryable,
      );
    }

    logger.debug(log, '9japay request ok');
    return body;
  }
}

/** 9jaPay's numeric codes, as names the services can branch on. */
function codeName(statusCode: string | undefined): string | null {
  switch (statusCode) {
    case '25':
      return 'NOT_FOUND';
    case '26':
      return 'DUPLICATE';
    case '09':
      return 'VALIDATION_ERROR';
    case '06':
      return 'GENERAL_ERROR';
    default:
      return statusCode ?? null;
  }
}

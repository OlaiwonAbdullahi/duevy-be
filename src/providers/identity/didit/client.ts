import { logger } from '../../../lib/logger';
import { ProviderError } from '../../payment/types';

/**
 * Thin fetch wrapper for Didit's verification API (docs.didit.me).
 * Authenticated with `x-api-key`. Returns 2xx and 4xx bodies to the caller,
 * which decides what a refusal means; 429, 5xx and network failures throw a
 * retryable ProviderError (Didit doesn't bill those).
 *
 * Bodies are never logged: they carry phone numbers, BVNs and dates of birth.
 */

const TIMEOUT_MS = 20_000;

export interface DiditResponse<T> {
  status: number;
  body: T;
}

export class DiditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async post<T>(path: string, body: unknown, op: string): Promise<DiditResponse<T>> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ op, err: (err as Error).message }, 'didit request did not complete');
      throw new ProviderError(`Didit ${op} did not complete`, null, null, true);
    }
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    const log = { op, status: res.status, ms: Date.now() - started };
    if (res.status === 429 || res.status >= 500) {
      const code = (parsed as { code?: string }).code ?? null;
      logger.warn({ ...log, code }, 'didit request failed');
      throw new ProviderError(`Didit ${op} failed with ${res.status}`, res.status, code, true);
    }
    if (res.status === 401 || res.status === 403) {
      // A bad key, or the account is out of credit: an operator problem, not the rep's.
      logger.error(log, 'didit refused our credentials or has no credit');
      throw new ProviderError('Identity checks are unavailable right now', res.status, 'DIDIT_UNAVAILABLE', true);
    }
    logger.debug(log, 'didit request done');
    return { status: res.status, body: parsed as T };
  }
}

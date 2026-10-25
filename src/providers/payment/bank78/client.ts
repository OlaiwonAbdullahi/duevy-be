import { logger } from '../../../lib/logger';
import { ProviderError } from '../types';

/**
 * Thin fetch wrapper for the Bank78 public API
 * (78financials-bank78.github.io/bank78-public-api-docs).
 *
 *  - One base host; each service lives under its own path: /identity,
 *    /virtual-nuban, /sub-account, /payout.
 *  - Every call carries `Authorization: Bearer <token>` and `x-api-key`. The
 *    token is a client_credentials grant from /identity/connect/token, valid
 *    for an hour; it is cached and refreshed a minute early, and once more on
 *    a 401.
 *  - Responses are wrapped as { successful, result, message, errorCode,
 *    responseCode }. `successful: false` is an error whatever the HTTP status;
 *    we branch on responseCode/errorCode, never on the human message.
 *
 * Request and response bodies are never logged: they carry NINs, account
 * numbers and names. Only method, path, status and timing are.
 */

export interface Bank78Request {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** Short label for logs, e.g. "payout.send". */
  op: string;
  /** Payment reference for log correlation. */
  ref?: string;
}

export interface Bank78Envelope<T> {
  hasResult?: boolean;
  result: T;
  message?: string | null;
  successful?: boolean;
  errorCode?: number | string | null;
  responseCode?: string | null;
}

export interface Bank78Credentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

const TIMEOUT_MS = 20_000;
const TOKEN_EARLY_REFRESH_MS = 60_000;

/** The machine-readable code of a failed envelope: responseCode, else a non-zero errorCode. */
function errorCodeOf(body: Partial<Bank78Envelope<unknown>>): string | null {
  if (body.responseCode) return String(body.responseCode);
  if (body.errorCode !== undefined && body.errorCode !== null && body.errorCode !== 0 && body.errorCode !== '0') return String(body.errorCode);
  return null;
}

export class Bank78Client {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(private readonly creds: Bank78Credentials) {}

  /** The full envelope, for calls whose meaning is in responseCode (payouts). */
  async call<T>(req: Bank78Request): Promise<Bank78Envelope<T>> {
    let res = await this.send(req, await this.getToken());
    if (res.status === 401) {
      this.token = null;
      res = await this.send(req, await this.getToken());
    }

    const text = await res.text();
    const log = { op: req.op, ref: req.ref, path: req.path, status: res.status };
    let body: Partial<Bank78Envelope<T>> = {};
    try {
      body = text ? (JSON.parse(text) as Bank78Envelope<T>) : {};
    } catch {
      if (res.ok) throw new ProviderError(`Bank78 ${req.op} returned a non-JSON body`, res.status, null, false);
    }

    if (!res.ok || body.successful === false) {
      const code = errorCodeOf(body);
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        code === 'service_unavailable' ||
        code === 'internal_error';
      logger.warn({ ...log, code }, 'bank78 request failed');
      throw new ProviderError(body.message ?? `Bank78 ${req.op} failed with ${res.status}`, res.status, code, retryable);
    }

    logger.debug(log, 'bank78 request ok');
    return body as Bank78Envelope<T>;
  }

  /** Just the `result` of a successful call. */
  async request<T>(req: Bank78Request): Promise<T> {
    return (await this.call<T>(req)).result;
  }

  private async send(req: Bank78Request, token: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'x-api-key': this.creds.apiKey,
      Accept: 'application/json',
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;

    try {
      return await fetch(new URL(req.path, this.creds.baseUrl), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ op: req.op, ref: req.ref, path: req.path, err: (err as Error).message }, 'bank78 request did not complete');
      // A timeout is NOT proof the call failed; callers retry with the same reference.
      throw new ProviderError(`Bank78 ${req.op} did not complete: ${(err as Error).message}`, null, null, true);
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    // One token request at a time; concurrent callers share it.
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(new URL('/identity/connect/token', this.creds.baseUrl), {
        method: 'POST',
        headers: { 'x-api-key': this.creds.apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError(`Bank78 token request did not complete: ${(err as Error).message}`, null, null, true);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      logger.error({ status: res.status }, 'bank78 token request refused — check BANK78_CLIENT_ID, BANK78_CLIENT_SECRET and BANK78_API_KEY');
      throw new ProviderError('Bank78 refused the API credentials', res.status, 'AUTH_FAILED', res.status >= 500);
    }
    const ttlMs = (body.expires_in ?? 3600) * 1000;
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(ttlMs - TOKEN_EARLY_REFRESH_MS, 0) };
    return body.access_token;
  }
}

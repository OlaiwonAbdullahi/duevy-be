import { logger } from '../../../lib/logger';
import { ProviderError } from '../types';

/**
 * Thin fetch wrapper for Interswitch (docs.interswitchgroup.com).
 *
 * Interswitch spreads one integration across several hosts:
 *   - Passport (OAuth2 client-credentials) issues the Bearer token used by the
 *     Payouts and Virtual Account APIs.
 *   - Web Checkout's transaction query (gettransaction.json) is a plain GET on
 *     the collections host and is NOT Bearer-authenticated.
 *
 * So each call names its own base URL and whether it needs the token. The
 * token is cached and refreshed ~60s before it expires.
 *
 * Request and response bodies are never logged: they carry account numbers,
 * names and card data. Only method, path, status and timing are.
 */

const TIMEOUT_MS = 20_000;
/** Refresh the Passport token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

export interface InterswitchConfig {
  env: 'test' | 'live';
  clientId: string;
  clientSecret: string;
  merchantCode: string;
  payItemId: string;
  /** ISO-4217 numeric currency (566 = NGN). */
  currency: string;
  /** Passport OAuth2 token endpoint. */
  passportUrl: string;
  /** Base host for Web Checkout's gettransaction.json query. */
  collectionsUrl: string;
  /** Base URL for the Payouts API. */
  payoutsUrl: string;
  /** Base host for the Virtual Accounts API. */
  vaUrl: string;
  /** Host that serves inline-checkout.js to the frontend. */
  inlineCheckoutUrl: string;
  /** Secret used to verify dashboard webhook signatures (required in live). */
  webhookSecret?: string;
}

export interface InterswitchRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** The base URL this call goes to (collections / payouts / va). */
  baseUrl: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** false = send no Bearer token (e.g. the public transaction query). */
  auth?: boolean;
  /** Short label for logs, e.g. "payout.create". */
  op: string;
  /** Our reference, for log correlation. */
  ref?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class InterswitchClient {
  private token: { value: string; expiresAt: number } | null = null;
  /** De-duplicate concurrent token fetches. */
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly cfg: InterswitchConfig) {}

  /** A cached Passport access token, refreshed before it expires. */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_SKEW_MS) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(this.cfg.passportUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials&scope=profile',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ op: 'passport.token', err: (err as Error).message }, 'interswitch token request did not complete');
      throw new ProviderError(`Interswitch token request did not complete: ${(err as Error).message}`, null, null, true);
    }
    const text = await res.text();
    let body: TokenResponse = {};
    try {
      body = text ? (JSON.parse(text) as TokenResponse) : {};
    } catch {
      /* fall through to the error below */
    }
    if (!res.ok || !body.access_token) {
      const retryable = res.status === 429 || res.status >= 500;
      logger.warn({ op: 'passport.token', status: res.status, ms: Date.now() - started }, 'interswitch token request failed');
      throw new ProviderError(`Interswitch token request failed with ${res.status}`, res.status, null, retryable);
    }
    const ttlMs = (body.expires_in ?? 3600) * 1000;
    this.token = { value: body.access_token, expiresAt: Date.now() + ttlMs };
    logger.debug({ op: 'passport.token', ms: Date.now() - started }, 'interswitch token refreshed');
    return body.access_token;
  }

  async request<T>(req: InterswitchRequest): Promise<T> {
    const url = new URL(req.path, req.baseUrl.endsWith('/') ? req.baseUrl : `${req.baseUrl}/`);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (req.auth !== false) headers.Authorization = `Bearer ${await this.getToken()}`;
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
      logger.warn({ op: req.op, ref: req.ref, err: (err as Error).message }, 'interswitch request did not complete');
      // A timeout is NOT proof the call failed; callers check status before retrying.
      throw new ProviderError(`Interswitch ${req.op} did not complete: ${(err as Error).message}`, null, null, true);
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new ProviderError(`Interswitch ${req.op} returned a non-JSON body`, res.status, null, false);
    }
    const log = { op: req.op, ref: req.ref, status: res.status, ms: Date.now() - started };

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const code = responseCodeOf(body);
      logger.warn({ ...log, code }, 'interswitch request failed');
      throw new ProviderError(messageOf(body) ?? `Interswitch ${req.op} failed with ${res.status}`, res.status, code, retryable);
    }

    logger.debug(log, 'interswitch request ok');
    return body as T;
  }

  get config(): InterswitchConfig {
    return this.cfg;
  }
}

/** Pull a machine-readable response code out of whatever shape Interswitch returned. */
function responseCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const raw = b.responseCode ?? b.ResponseCode ?? b.code ?? b.errorCode;
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
}

/** Pull a human message out of an Interswitch error body. */
function messageOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const raw = b.message ?? b.Message ?? b.responseDescription ?? b.ResponseDescription ?? b.description ?? b.error;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

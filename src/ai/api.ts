import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * The AI agent's tools act on Duevy through its OWN public REST API, server-side,
 * carrying a short-lived JWT minted for the linked rep (see identity.ts). This
 * is deliberate: every call goes through the exact same auth (requireSpaceRep),
 * zod validation, KYC gates, idempotency and confirmation logic as the web
 * dashboard — so the chat can never do more than the rep could do in the UI,
 * and "the dashboard still works if chat fails" is true by construction.
 */

const BASE = (env.INTERNAL_API_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  /** The API envelope's `data` on success, or the error object on failure. */
  data: T;
  /** A short human message when the call failed. */
  error?: string;
}

export interface ApiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  token: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Set to send an Idempotency-Key (required by the withdrawal endpoint). */
  idempotent?: boolean;
}

export async function apiCall<T = unknown>(opts: ApiCallOptions): Promise<ApiResult<T>> {
  const url = new URL(`${BASE}/v1${opts.path.startsWith('/') ? '' : '/'}${opts.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotent) headers['Idempotency-Key'] = randomUUID();

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ path: opts.path, err: (err as Error).message }, 'ai internal api call did not complete');
    return { ok: false, status: 0, data: null as T, error: 'The request could not be completed. Try again.' };
  }

  const text = await res.text();
  let body: { success?: boolean; data?: T; error?: { code?: string; message?: string } } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON */
  }

  if (!res.ok || body.success === false) {
    return {
      ok: false,
      status: res.status,
      data: (body.error ?? null) as T,
      error: body.error?.message ?? `Request failed (${res.status})`,
    };
  }
  return { ok: true, status: res.status, data: (body.data ?? null) as T };
}

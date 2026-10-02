import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured logger. Every money-path log line carries the payment reference
 * (`ref`) so one grep follows a checkout or withdrawal end to end.
 *
 * Never log a BVN, a date of birth, a token, a secret or a full account
 * number. The redact list below is the safety net for objects logged by key;
 * `scrub()` is the one for payloads whose shape we don't control (provider
 * responses, webhook bodies) and should be applied before logging them.
 */
const REDACT_KEYS = [
  'bvn',
  'dob',
  'dateOfBirth',
  'date_of_birth',
  'id_numbers',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'accountNumber',
  'account_number',
  'sender_account_number',
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'duevy-api' },
  redact: {
    paths: [
      ...REDACT_KEYS,
      ...REDACT_KEYS.map((k) => `*.${k}`),
      ...REDACT_KEYS.map((k) => `*.*.${k}`),
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-bachs-signature"]',
      'req.headers["x-bachs-signature-v2"]',
    ],
    censor: '[redacted]',
  },
});

const SENSITIVE = new RegExp(`^(${REDACT_KEYS.join('|')})$`, 'i');

/** Deep-copy `value` with every sensitive key replaced. Safe on any JSON-ish input. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out as T;
}

/** "0123456789" → "••••6789" — the only form an account number may appear in logs. */
export function maskTail(value: string | null | undefined): string | null {
  if (!value) return null;
  return `••••${value.slice(-4)}`;
}

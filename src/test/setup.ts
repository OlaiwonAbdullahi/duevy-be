/**
 * Minimal env so importing anything that reaches src/config/env.ts doesn't
 * exit the worker. dotenv does not overwrite values already on process.env, so
 * these win over whatever is in a local .env.
 *
 * Integration tests (vitest.int.config.ts) override DATABASE_URL with a
 * throwaway Postgres before this runs; unit tests never open a connection.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/duevy_test',
  DIRECT_URL: 'postgresql://user:pass@localhost:5432/duevy_test',
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-chars',
  JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-chars',
  RESEND_API_KEY: 're_test',
  // Never a real host: integration tests swap in the in-memory double, and
  // anything that slips past it fails against the sandbox's auth.
  BANK78_BASE_URL: 'https://sandbox.bank78.co',
  BANK78_CLIENT_ID: 'test-client',
  BANK78_CLIENT_SECRET: 'test-client-secret',
  BANK78_API_KEY: 'test-api-key',
  BANK78_WEBHOOK_SECRET: 'whsec_test_secret',
  BANK78_ALLOW_LIVE_OUTSIDE_PRODUCTION: 'false',
  DIDIT_BASE_URL: 'https://didit.invalid',
  DIDIT_API_KEY: 'test-didit-key',
  RUN_WORKERS: 'false',
  FILE_STORAGE: 'memory',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}

/**
 * Minimal env so importing anything that reaches src/config/env.ts doesn't
 * exit the worker. dotenv does not overwrite values already on process.env, so
 * these win over whatever is in a local .env.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/duevy_test',
  DIRECT_URL: 'postgresql://user:pass@localhost:5432/duevy_test',
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-chars',
  JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-chars',
  RESEND_API_KEY: 're_test',
  ANCHOR_SECRET_KEY: 'test-anchor-key',
  ANCHOR_BASE_URL: 'https://api.sandbox.getanchor.co',
  ANCHOR_WEBHOOK_SECRET: 'whsec12345',
  ANCHOR_SETTLEMENT_ACCOUNT_ID: '012345678901234-anc_acc',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Database
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Google Sign-In (§2.3). Optional: while unset, POST /auth/google returns 501.
  GOOGLE_CLIENT_ID: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string(),
  RESEND_FROM_EMAIL: z.string().default('Duevy <no-reply@duevy.app>'),

  // Anchor (getanchor.co) — the sole payment processor. See src/lib/anchor.ts.
  ANCHOR_SECRET_KEY: z.string(),
  ANCHOR_BASE_URL: z.string().url().default('https://api.sandbox.getanchor.co'),
  // Webhook token for verifying POST /webhooks/anchor signatures. Anchor caps
  // the token it will accept at 10 characters, so a longer secret can never be
  // registered with them and would fail every signature check.
  ANCHOR_WEBHOOK_SECRET: z.string().min(1).max(10),
  // Duevy Labs' own Anchor deposit account. Two roles, deliberately one
  // account: every student payment settles here first (Pay With Transfer has no
  // settlement destination — see anchor.ts), and it is the source of the book
  // transfers that remit each department's share on. Duevy's margin is simply
  // whatever stays behind, so there is no separate revenue account to sweep to.
  ANCHOR_SETTLEMENT_ACCOUNT_ID: z.string(),
  // Which bank issues the checkout account number. Anchor picks one if unset,
  // but the student sees this bank's name on the transfer screen, so pinning a
  // recognisable one (providus, wema) is worth doing.
  ANCHOR_VA_PROVIDER: z
    .enum(['wema', 'providus', 'gtb', 'ninepsb', 'corestep', 'column', 'circle', 'anchor'])
    .optional(),
  // How long a checkout stays open, in seconds (PRD §5.2 — 30 minutes). Unlike
  // the virtual-NUBAN flow this is load-bearing: Pay With Transfer takes it as
  // `expiryTime` and enforces it, so a late transfer genuinely cannot land.
  ANCHOR_VA_EXPIRY_SECONDS: z.coerce.number().int().positive().default(1800),

  // App
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3001'),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),

  // Security
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  // Optional dedicated key for encrypting stored bank account numbers.
  // Falls back to a key derived from JWT_REFRESH_SECRET when unset.
  ENCRYPTION_KEY: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // Pilot feature gates — these ship fully built but are cut from the MVP
  // pilot scope. Off by default; flip to 'true' (no code change) to re-enable
  // for Phase 2. See src/middleware/requireFeature.ts.
  FEATURE_POLLS: z.string().transform((v) => v === 'true').default('false'),
  FEATURE_ASSISTANT: z.string().transform((v) => v === 'true').default('false'),
  FEATURE_REFERRALS: z.string().transform((v) => v === 'true').default('false'),

  // Duey (AI assistant) classification backend — 'ollama' talks to a local/dev
  // Ollama instance; 'gemini' talks to Google's Gemini API natively (no
  // OpenAI-compat shim); 'hosted' talks to any other OpenAI-chat-completions
  // -compatible endpoint (self-hosted vLLM box, etc.). Handler code never
  // changes regardless of which is picked (§ Duey adapter contract).
  LLM_PROVIDER: z.enum(['ollama', 'gemini', 'hosted']).default('ollama'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('gemma2:9b'),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
  LLM_HOSTED_BASE_URL: z.string().url().optional(),
  LLM_HOSTED_API_KEY: z.string().optional(),
  LLM_HOSTED_MODEL: z.string().default('gemma-2-9b-it'),
  LLM_TIMEOUT_MS: z.coerce.number().default(8000),
}).superRefine((val, ctx) => {
  if (val.LLM_PROVIDER === 'gemini' && !val.GEMINI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['GEMINI_API_KEY'], message: 'required when LLM_PROVIDER=gemini' });
  }
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌  Invalid environment variables:');
    const errors = result.error.flatten().fieldErrors;
    Object.entries(errors).forEach(([field, msgs]) => {
      console.error(`   ${field}: ${msgs?.join(', ')}`);
    });
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();

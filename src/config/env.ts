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

  // Bachs Connect (bachs.io) — the sole payment processor. See src/lib/bachs.ts.
  BACHS_SECRET_KEY: z.string(),
  BACHS_BASE_URL: z.string().url().default('https://sandbox-api.bachs.io'),
  // HMAC secret for verifying POST /webhooks/bachs signatures.
  BACHS_WEBHOOK_SECRET: z.string(),

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

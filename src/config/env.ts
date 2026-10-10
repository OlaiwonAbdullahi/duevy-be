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

  // Google Sign-In (§2.3). Optional: while unset, POST /auth/google returns 501.
  GOOGLE_CLIENT_ID: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string(),
  RESEND_FROM_EMAIL: z.string().default('Duevy <no-reply@duevy.app>'),

  // Payment rail. 'bachs' is the only live provider; 'fake' is an in-memory
  // stand-in for local development, the seed and the test suite. See
  // src/providers/payment/.
  PAYMENT_PROVIDER: z.enum(['bachs', 'fake']).default('bachs'),

  // Bachs (docs.bachs.io) — Connect platform. sk_sandbox_… against the sandbox
  // URL, sk_live_… against https://api.bachs.io; going live is a key swap.
  BACHS_BASE_URL: z.string().url().default('https://sandbox-api.bachs.io'),
  BACHS_SECRET_KEY: z.string().optional(),
  // The signing secret of the webhook endpoint registered for /v1/webhooks/bachs
  // (returned once, at endpoint creation). During a rotation Bachs keeps the old
  // secret valid for 24h, so the outgoing one can be kept here meanwhile.
  BACHS_WEBHOOK_SECRET: z.string().optional(),
  BACHS_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  // Reject signed deliveries whose timestamp is further than this from now.
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  // How long a checkout's one-time bank account stays open (Bachs allows 1–1440).
  CHECKOUT_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  // Run the webhook/job worker and reconciliation inside the API process.
  // Turn off when they run as a separate process (npm run worker).
  RUN_WORKERS: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),

  // Private file storage for KYC documents (the rep's student ID card).
  // 'imagekit' in every real environment; 'memory' only for tests and local
  // development without ImageKit keys (refused in production).
  FILE_STORAGE: z.enum(['imagekit', 'memory']).default('imagekit'),
  IMAGEKIT_PRIVATE_KEY: z.string().optional(),
  // e.g. https://ik.imagekit.io/your_imagekit_id
  IMAGEKIT_URL_ENDPOINT: z.string().url().optional(),
  // Folder that holds KYC documents. Restrict it in the ImageKit dashboard
  // (files are uploaded as private, so they are only served via signed URLs).
  IMAGEKIT_KYC_FOLDER: z.string().default('/duevy/kyc'),

  // Structured logging (pino)
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

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
  if (val.PAYMENT_PROVIDER === 'bachs') {
    for (const key of ['BACHS_SECRET_KEY', 'BACHS_WEBHOOK_SECRET'] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when PAYMENT_PROVIDER=bachs' });
    }
  }
  if (val.PAYMENT_PROVIDER === 'bachs' && val.BACHS_SECRET_KEY) {
    // Dev and prod are separate databases with separate keys: sandbox keys
    // everywhere except production, which takes the live key. Refuse a key
    // that points at the wrong Bachs environment, and a live key outside
    // production (a dev database must never move real money).
    const live = val.BACHS_SECRET_KEY.startsWith('sk_live_');
    const liveUrl = new URL(val.BACHS_BASE_URL).hostname === 'api.bachs.io';
    if (live !== liveUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BACHS_BASE_URL'],
        message: live ? 'an sk_live_ key needs https://api.bachs.io' : 'an sk_sandbox_ key needs https://sandbox-api.bachs.io',
      });
    }
    if (live && val.NODE_ENV !== 'production') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BACHS_SECRET_KEY'], message: 'live Bachs keys only run with NODE_ENV=production' });
    }
  }
  if (val.FILE_STORAGE === 'imagekit') {
    for (const key of ['IMAGEKIT_PRIVATE_KEY', 'IMAGEKIT_URL_ENDPOINT'] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when FILE_STORAGE=imagekit' });
    }
  }
  if (val.NODE_ENV === 'production' && val.FILE_STORAGE === 'memory') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FILE_STORAGE'], message: 'memory storage cannot run in production' });
  }
  if (val.NODE_ENV === 'production' && val.PAYMENT_PROVIDER === 'fake') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_PROVIDER'], message: 'the fake provider cannot run in production' });
  }
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

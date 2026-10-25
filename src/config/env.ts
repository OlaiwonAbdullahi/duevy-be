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

  // Payment rail: Bank78 (78financials-bank78.github.io/bank78-public-api-docs).
  // Sandbox https://sandbox.bank78.co; live https://api.bank78.co. The client
  // id/secret and API key come from the merchant dashboard (API Credentials).
  BANK78_BASE_URL: z.string().url().default('https://sandbox.bank78.co'),
  BANK78_CLIENT_ID: z.string().min(1),
  BANK78_CLIENT_SECRET: z.string().min(1),
  BANK78_API_KEY: z.string().min(1),
  // The Webhook Secret set on the merchant profile. During a rotation keep the
  // outgoing one in _PREVIOUS until Bank78 stops signing with it.
  BANK78_WEBHOOK_SECRET: z.string().min(1),
  BANK78_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  // Live Bank78 moves real money, so it only runs under NODE_ENV=production
  // unless this is set deliberately.
  BANK78_ALLOW_LIVE_OUTSIDE_PRODUCTION: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Didit (docs.didit.me) — rep KYC: NIN database validation and phone OTP.
  DIDIT_BASE_URL: z.string().url().default('https://verification.didit.me'),
  DIDIT_API_KEY: z.string().min(1),

  // Reject signed deliveries whose timestamp is further than this from now.
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  // How long a checkout's one-time bank account stays open, in minutes.
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
  // Number of reverse-proxy hops in front of the API (Render = 1). Needed so
  // req.ip is the client's address and per-IP rate limits aren't shared by
  // every user. Defaults to 1 in production, 0 (don't trust) elsewhere.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).optional(),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
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
  // Dev and prod are separate databases: sandbox everywhere except production.
  // A dev database must never move real money.
  if (new URL(val.BANK78_BASE_URL).hostname === 'api.bank78.co' && val.NODE_ENV !== 'production' && !val.BANK78_ALLOW_LIVE_OUTSIDE_PRODUCTION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BANK78_BASE_URL'],
      message: 'live Bank78 (api.bank78.co) only runs with NODE_ENV=production; use https://sandbox.bank78.co',
    });
  }
  if (val.FILE_STORAGE === 'imagekit') {
    for (const key of ['IMAGEKIT_PRIVATE_KEY', 'IMAGEKIT_URL_ENDPOINT'] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when FILE_STORAGE=imagekit' });
    }
  }
  if (val.NODE_ENV === 'production' && val.FILE_STORAGE === 'memory') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FILE_STORAGE'], message: 'memory storage cannot run in production' });
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

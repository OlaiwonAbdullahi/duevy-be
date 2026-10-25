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

  // Payment rail. 'kredi' is the only live provider; 'fake' is an in-memory
  // stand-in for local development, the seed and the test suite. See
  // src/providers/payment/.
  PAYMENT_PROVIDER: z.enum(['kredi', 'fake']).default('kredi'),

  // Kredi Pay (documentation.thekredibank.com). Sandbox:
  // https://walletv2-api.test.kredimfb.com. Both credentials come from the
  // dashboard (Settings → API/Webhook); generating a new token invalidates the
  // old one, so rotate KREDI_AUTH_TOKEN everywhere at once.
  KREDI_BASE_URL: z.string().url().optional(),
  KREDI_API_KEY: z.string().optional(),
  KREDI_AUTH_TOKEN: z.string().optional(),
  // The secret Kredi signs webhooks with (signature-key = sha512 of
  // "amount-secret-reference"). Keep the outgoing one here during a rotation.
  KREDI_WEBHOOK_SECRET: z.string().optional(),
  KREDI_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),

  // Rep identity checks (Didit, docs.didit.me): phone OTP and BVN match, both
  // before the rep is registered with Kredi. 'fake' for tests and local dev.
  IDENTITY_PROVIDER: z.enum(['didit', 'fake']).default('didit'),
  DIDIT_BASE_URL: z.string().url().default('https://verification.didit.me'),
  DIDIT_API_KEY: z.string().optional(),
  // How the OTP is delivered: sms | whatsapp | telegram | voice.
  DIDIT_PHONE_CHANNEL: z.enum(['sms', 'whatsapp', 'telegram', 'voice']).default('sms'),
  // The Nigeria BVN database-validation service id from the Didit console.
  // Unset runs Didit's default Nigeria service.
  DIDIT_BVN_SERVICE: z.string().optional(),
  // Keys the one-way BVN fingerprint that stops one BVN backing two reps.
  // Changing it orphans every stored fingerprint.
  BVN_HASH_PEPPER: z.string().min(32).optional(),

  // How long a checkout's payment link is treated as open (1–1440).
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
  if (val.PAYMENT_PROVIDER === 'kredi') {
    for (const key of ['KREDI_BASE_URL', 'KREDI_API_KEY', 'KREDI_AUTH_TOKEN', 'KREDI_WEBHOOK_SECRET'] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when PAYMENT_PROVIDER=kredi' });
    }
  }
  if (val.PAYMENT_PROVIDER === 'kredi' && val.KREDI_BASE_URL) {
    // Dev and prod are separate databases with separate keys: the test host
    // everywhere except production, which takes the live one. A dev database
    // must never move real money.
    const testHost = new URL(val.KREDI_BASE_URL).hostname.includes('.test.');
    if (val.NODE_ENV === 'production' && testHost) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['KREDI_BASE_URL'], message: 'production needs the live Kredi API, not the test host' });
    }
    if (val.NODE_ENV !== 'production' && !testHost) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['KREDI_BASE_URL'], message: 'the live Kredi API only runs with NODE_ENV=production' });
    }
  }
  if (val.IDENTITY_PROVIDER === 'didit' && !val.DIDIT_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DIDIT_API_KEY'], message: 'required when IDENTITY_PROVIDER=didit' });
  }
  if (val.NODE_ENV !== 'test' && !val.BVN_HASH_PEPPER) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BVN_HASH_PEPPER'], message: 'required (32+ characters)' });
  }
  if (val.NODE_ENV === 'production' && val.IDENTITY_PROVIDER === 'fake') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['IDENTITY_PROVIDER'], message: 'the fake identity provider cannot run in production' });
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

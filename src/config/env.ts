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

  // Payment rail. 'ninejapay' is the only live provider; 'fake' is an
  // in-memory stand-in for local development, the seed and the test suite.
  // See src/providers/payment/ and docs/NINEJAPAY.md.
  PAYMENT_PROVIDER: z.enum(['ninejapay', 'fake']).default('ninejapay'),

  // 9jaPay (docs.9japay.com) — virtual accounts under Duevy's own business.
  // The live base URL comes from 9jaPay at onboarding.
  NINEJAPAY_BASE_URL: z.string().url().default('https://developer.test.9japay.com'),
  NINEJAPAY_API_KEY: z.string().optional(),
  // Also the webhook signing key: 9jaPay signs deliveries with it.
  NINEJAPAY_SECRET_KEY: z.string().optional(),
  // Duevy's business (collection) account: where collections settle and
  // sweeps are sent from. Its name is looked up from 9jaPay, not configured.
  NINEJAPAY_BUSINESS_ACCOUNT_NUMBER: z.string().optional(),
  // 9jaPay's own bank code, for transfers into a space's account.
  NINEJAPAY_BANK_CODE: z.string().default('090629'),
  // A space's unswept collections below this wait for the next day's sweep.
  SWEEP_MIN_KOBO: z.coerce.number().int().positive().default(100_000),
  // 9jaPay's daily transfer limit on the business account (₦10M for now; it
  // will be raised). Every sweep leaves from it, so all spaces' sweeps in a
  // Lagos day share it. Withdrawals leave from each space's own account and
  // don't count here.
  NINEJAPAY_BUSINESS_DAILY_LIMIT_KOBO: z.coerce.number().int().positive().default(1_000_000_000),

  // Didit (docs.didit.me) — rep NIN + date of birth checks against NIMC.
  // Required with the live rail. Under PAYMENT_PROVIDER=fake, leaving the key
  // unset uses an in-memory verifier instead.
  DIDIT_BASE_URL: z.string().url().default('https://verification.didit.me'),
  DIDIT_API_KEY: z.string().optional(),

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
  FEATURE_REFERRALS: z.string().transform((v) => v === 'true').default('false'),
}).superRefine((val, ctx) => {
  if (val.PAYMENT_PROVIDER === 'ninejapay') {
    for (const key of [
      'NINEJAPAY_API_KEY',
      'NINEJAPAY_SECRET_KEY',
      'NINEJAPAY_BUSINESS_ACCOUNT_NUMBER',
    ] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when PAYMENT_PROVIDER=ninejapay' });
    }
  }
  if (val.PAYMENT_PROVIDER !== 'fake' && !val.DIDIT_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DIDIT_API_KEY'], message: 'required for rep NIN checks' });
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

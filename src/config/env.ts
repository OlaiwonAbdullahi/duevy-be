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

  // Payment rail. 'interswitch' is the hackathon rail (Interswitch IPG Web
  // Checkout for students + Virtual Accounts & Payouts for spaces);
  // 'ninejapay' is the previous live provider, kept selectable; 'fake' is an
  // in-memory stand-in for local development, the seed and the test suite.
  // See src/providers/payment/ and docs/INTERSWITCH.md / docs/NINEJAPAY.md.
  PAYMENT_PROVIDER: z.enum(['interswitch', 'ninejapay', 'fake']).default('ninejapay'),

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
  // Sandbox only: the key 9jaPay issues for its simulate-deposit call. Set, on
  // the sandbox base URL, it turns on POST /v1/dev/simulate-deposit.
  NINEJAPAY_SANDBOX_AUTH_KEY: z.string().optional(),
  // A space's unswept collections below this wait for the next day's sweep.
  SWEEP_MIN_KOBO: z.coerce.number().int().positive().default(100_000),
  // 9jaPay's daily transfer limit on the business account (₦10M for now; it
  // will be raised). Every sweep leaves from it, so all spaces' sweeps in a
  // Lagos day share it. Withdrawals leave from each space's own account and
  // don't count here.
  NINEJAPAY_BUSINESS_DAILY_LIMIT_KOBO: z.coerce.number().int().positive().default(1_000_000_000),

  // ---------------------------------------------------------------------------
  // Interswitch — the hackathon payment rail (docs.interswitchgroup.com).
  //   * Students pay via IPG Web Checkout (card popup). The "one-time account"
  //     is the per-attempt txn_ref (= our checkout reference), created and
  //     stored server-side before the popup, then requeried on gettransaction.json.
  //   * Spaces get a permanent Interswitch Virtual Account; withdrawals go out
  //     through the Payouts API. See docs/INTERSWITCH.md.
  // Required only when PAYMENT_PROVIDER=interswitch (superRefine below).
  // ---------------------------------------------------------------------------
  INTERSWITCH_ENV: z.enum(['test', 'live']).default('test'),
  // Passport OAuth2 client credentials (Quickteller Business → Developer Tools).
  INTERSWITCH_CLIENT_ID: z.string().optional(),
  INTERSWITCH_CLIENT_SECRET: z.string().optional(),
  // Web Checkout merchant + pay item. TEST: MX6072 / 9405967.
  // LIVE: MX153376 + the team's own Pay Item ID from the Resources sheet.
  INTERSWITCH_MERCHANT_CODE: z.string().optional(),
  INTERSWITCH_PAY_ITEM_ID: z.string().optional(),
  // ISO-4217 numeric currency. 566 = NGN.
  INTERSWITCH_CURRENCY: z.string().default('566'),
  // Secret used to verify webhook signatures from the Quickteller dashboard.
  INTERSWITCH_WEBHOOK_SECRET: z.string().optional(),
  // Base URLs. Defaults are the test hosts; the live hosts are set per-env.
  // Passport (OAuth2 token):
  INTERSWITCH_PASSPORT_URL: z.string().url().default('https://sandbox.interswitchng.com/passport/oauth/token'),
  // Transaction query (gettransaction.json) + collections base:
  INTERSWITCH_COLLECTIONS_URL: z.string().url().default('https://sandbox.interswitchng.com'),
  // Payouts API base:
  INTERSWITCH_PAYOUTS_URL: z.string().url().default('https://payouts-sandbox.interswitchng.com/api/v1/payouts'),
  // Virtual Accounts API base (confirm the exact host in the portal):
  INTERSWITCH_VA_URL: z.string().url().default('https://sandbox.interswitchng.com'),
  // Host that serves inline-checkout.js for the frontend. TEST:
  // newwebpay.qa.interswitchng.com ; LIVE: newwebpay.interswitchng.com.
  INTERSWITCH_INLINE_CHECKOUT_URL: z
    .string()
    .url()
    .default('https://newwebpay.qa.interswitchng.com/inline-checkout.js'),

  // ---------------------------------------------------------------------------
  // AI assistant — NVIDIA NIM (OpenAI-compatible). Drives the chat + WhatsApp
  // bot; every rep action runs as a tool over the existing REST API. See docs/AI.md.
  // ---------------------------------------------------------------------------
  AI_ENABLED: z.string().transform((v) => v === 'true').default('false'),
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_BASE_URL: z.string().url().default('https://integrate.api.nvidia.com/v1'),
  // meta/llama-3.3-70b-instruct was retired by NVIDIA (2026-08-26); this is a
  // current tool-calling model on build.nvidia.com. Override with AI_MODEL.
  AI_MODEL: z.string().default('nvidia/nemotron-3.5-super-vl-120b-a12b'),
  // Where the agent's tools call the Duevy REST API from (server-side, with a
  // short-lived JWT minted for the linked rep). Defaults to this process.
  INTERNAL_API_BASE_URL: z.string().url().optional(),

  // ---------------------------------------------------------------------------
  // WhatsApp bot — Baileys (unofficial WhatsApp Web client). See docs/WHATSAPP.md.
  // ---------------------------------------------------------------------------
  WHATSAPP_ENABLED: z.string().transform((v) => v === 'true').default('false'),
  // Directory for Baileys multi-file auth state (the linked session). Keep it
  // off version control and persistent across restarts.
  WHATSAPP_AUTH_DIR: z.string().default('./.whatsapp-auth'),

  // Didit (docs.didit.me) — rep NIN + date of birth checks against NIMC.
  // Required with the live rail. Under PAYMENT_PROVIDER=fake, leaving the key
  // unset uses an in-memory verifier instead.
  DIDIT_BASE_URL: z.string().url().default('https://verification.didit.me'),
  DIDIT_API_KEY: z.string().optional(),

  // How long a checkout's one-time bank account stays open, in minutes.
  CHECKOUT_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  // Run the webhook/job worker and reconciliation inside the API process.
  // Turn off when they run as a separate process (npm run worker).
  // Webhook events handled at once per process. Each holds a DB connection
  // while it writes, so keep it well under the Prisma pool size.
  WEBHOOK_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
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
  // Folder for PUBLIC images (avatars, poll images), served from ImageKit's
  // CDN. Must not be the KYC folder or under it.
  IMAGEKIT_PUBLIC_FOLDER: z.string().default('/duevy/public'),

  // Shared state across API instances (rate-limit counters). Required to run
  // more than one instance; unset = per-process limits (tests, local dev).
  // e.g. redis://redis:6379 (docker-compose.yml sets this for the API).
  REDIS_URL: z.string().url().optional(),

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
  if (val.PAYMENT_PROVIDER === 'interswitch') {
    for (const key of [
      'INTERSWITCH_CLIENT_ID',
      'INTERSWITCH_CLIENT_SECRET',
      'INTERSWITCH_MERCHANT_CODE',
      'INTERSWITCH_PAY_ITEM_ID',
    ] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when PAYMENT_PROVIDER=interswitch' });
    }
  }
  if (val.AI_ENABLED && !val.NVIDIA_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NVIDIA_API_KEY'], message: 'required when AI_ENABLED=true' });
  }
  if (val.PAYMENT_PROVIDER !== 'fake' && !val.DIDIT_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DIDIT_API_KEY'], message: 'required for rep NIN checks' });
  }
  if (val.FILE_STORAGE === 'imagekit') {
    for (const key of ['IMAGEKIT_PRIVATE_KEY', 'IMAGEKIT_URL_ENDPOINT'] as const) {
      if (!val[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when FILE_STORAGE=imagekit' });
    }
  }
  {
    const norm = (f: string) => `/${f.replace(/^\/+|\/+$/g, '')}/`;
    const pub = norm(val.IMAGEKIT_PUBLIC_FOLDER);
    const kyc = norm(val.IMAGEKIT_KYC_FOLDER);
    if (pub.startsWith(kyc) || kyc.startsWith(pub)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['IMAGEKIT_PUBLIC_FOLDER'], message: 'must not overlap IMAGEKIT_KYC_FOLDER (KYC documents are private)' });
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

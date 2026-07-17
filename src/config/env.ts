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

  // Which processor actually moves money — see src/lib/paymentGateway.ts.
  // Both providers' code is fully implemented; this just picks which one is
  // live. Switching back to 'monnify' needs no code changes, only env vars.
  PAYMENT_GATEWAY: z.enum(['monnify', 'paystack']).default('paystack'),

  // Monnify — kept fully working, just not the active gateway by default.
  // Optional now (rather than required) so a Paystack-only deploy doesn't
  // need dummy Monnify credentials just to pass env validation.
  MONNIFY_API_KEY: z.string().optional(),
  MONNIFY_SECRET_KEY: z.string().optional(),
  MONNIFY_BASE_URL: z.string().url().default('https://sandbox.monnify.com'),
  MONNIFY_CONTRACT_CODE: z.string().optional(),
  MONNIFY_WEBHOOK_SECRET: z.string().optional(),
  // Wallet account payouts are disbursed from. Optional: while unset, payout
  // requests are recorded but no transfer is initiated (§10.3 stays manual).
  MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT: z.string().optional(),

  // Paystack
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),

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

  // Duey (AI assistant) — Gemma classification backend. 'ollama' talks to a
  // local/dev Ollama instance; 'hosted' talks to any OpenAI-chat-compatible
  // endpoint (Gemini API in OpenAI-compat mode, a self-hosted GPU box, etc.)
  // without any handler code changing (§ Duey adapter contract).
  LLM_PROVIDER: z.enum(['ollama', 'hosted']).default('ollama'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('gemma2:9b'),
  LLM_HOSTED_BASE_URL: z.string().url().optional(),
  LLM_HOSTED_API_KEY: z.string().optional(),
  LLM_HOSTED_MODEL: z.string().default('gemma-2-9b-it'),
  LLM_TIMEOUT_MS: z.coerce.number().default(8000),
}).superRefine((val, ctx) => {
  if (val.PAYMENT_GATEWAY === 'paystack' && !val.PAYSTACK_SECRET_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYSTACK_SECRET_KEY'], message: 'required when PAYMENT_GATEWAY=paystack' });
  }
  if (val.PAYMENT_GATEWAY === 'monnify' && (!val.MONNIFY_API_KEY || !val.MONNIFY_SECRET_KEY || !val.MONNIFY_CONTRACT_CODE || !val.MONNIFY_WEBHOOK_SECRET)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MONNIFY_API_KEY'], message: 'MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE and MONNIFY_WEBHOOK_SECRET are all required when PAYMENT_GATEWAY=monnify' });
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

import { env } from '../../config/env';
import { Bank78Provider } from './bank78/Bank78Provider';
import { type PaymentProvider } from './types';

export * from './types';

let instance: PaymentProvider | null = null;

/** The payment rail (Bank78). One instance per process. */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;
  const secrets = [env.BANK78_WEBHOOK_SECRET, env.BANK78_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s);
  instance = new Bank78Provider({
    baseUrl: env.BANK78_BASE_URL,
    clientId: env.BANK78_CLIENT_ID,
    clientSecret: env.BANK78_CLIENT_SECRET,
    apiKey: env.BANK78_API_KEY,
    webhookSecrets: secrets,
    webhookToleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
  });
  return instance;
}

/** Test seam: swap the provider for an in-memory double (src/test/integration/paymentDouble.ts). */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  instance = provider;
}

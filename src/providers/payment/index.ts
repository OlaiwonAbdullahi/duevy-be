import { env } from '../../config/env';
import { BachsProvider } from './bachs/BachsProvider';
import { FakeProvider } from './fake/FakeProvider';
import { type PaymentProvider } from './types';

export * from './types';
export { FakeProvider } from './fake/FakeProvider';
export { MalformedEventError } from './bachs/events';

let instance: PaymentProvider | null = null;

/** The configured payment rail (PAYMENT_PROVIDER). One instance per process. */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;
  const secrets = [env.BACHS_WEBHOOK_SECRET, env.BACHS_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s);
  // The public 'whsec_fake' secret is only acceptable under tests; anywhere
  // else a missing secret would let anyone forge signed webhooks.
  if (!secrets.length) {
    if (env.NODE_ENV !== 'test') throw new Error('BACHS_WEBHOOK_SECRET is required');
    secrets.push('whsec_fake');
  }
  instance =
    env.PAYMENT_PROVIDER === 'fake'
      ? new FakeProvider(secrets, env.WEBHOOK_TOLERANCE_SECONDS)
      : new BachsProvider({
          baseUrl: env.BACHS_BASE_URL,
          secretKey: env.BACHS_SECRET_KEY as string,
          webhookSecrets: secrets,
          webhookToleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
        });
  return instance;
}

/** Test seam: swap the provider (e.g. for a FakeProvider with knobs set). */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  instance = provider;
}

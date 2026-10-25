import { env } from '../../config/env';
import { KrediProvider } from './kredi/KrediProvider';
import { FakeProvider } from './fake/FakeProvider';
import { type PaymentProvider } from './types';

export * from './types';
export { FakeProvider } from './fake/FakeProvider';
export { MalformedEventError } from './kredi/events';

let instance: PaymentProvider | null = null;

/** The configured payment rail (PAYMENT_PROVIDER). One instance per process. */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;
  const secrets = [env.KREDI_WEBHOOK_SECRET, env.KREDI_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s);
  // The public 'whsec_fake' secret is only acceptable under tests; anywhere
  // else a missing secret would let anyone forge signed webhooks.
  if (!secrets.length) {
    if (env.NODE_ENV !== 'test') throw new Error('KREDI_WEBHOOK_SECRET is required');
    secrets.push('whsec_fake');
  }
  instance =
    env.PAYMENT_PROVIDER === 'fake'
      ? new FakeProvider(secrets)
      : new KrediProvider({
          baseUrl: env.KREDI_BASE_URL as string,
          apiKey: env.KREDI_API_KEY as string,
          authToken: env.KREDI_AUTH_TOKEN as string,
          webhookSecrets: secrets,
          collectionWebhookUrl: `${env.APP_BASE_URL}/v1/webhooks/kredi`,
        });
  return instance;
}

/** Test seam: swap the provider (e.g. for a FakeProvider with knobs set). */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  instance = provider;
}

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
  instance =
    env.PAYMENT_PROVIDER === 'fake'
      ? new FakeProvider(secrets.length ? secrets : ['whsec_fake'], env.WEBHOOK_TOLERANCE_SECONDS)
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

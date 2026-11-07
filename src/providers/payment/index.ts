import { env } from '../../config/env';
import { NineJaPayProvider } from './ninejapay/NineJaPayProvider';
import { FakeProvider } from './fake/FakeProvider';
import { type PaymentProvider } from './types';

export * from './types';
export { FakeProvider } from './fake/FakeProvider';
export { MalformedEventError } from './ninejapay/events';

let instance: PaymentProvider | null = null;

/** The configured payment rail (PAYMENT_PROVIDER). One instance per process. */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;
  // 9jaPay signs webhooks with the API secret. The public 'whsec_fake' secret
  // is only acceptable under tests; anywhere else a missing secret would let
  // anyone forge signed webhooks.
  const secrets = [env.NINEJAPAY_SECRET_KEY].filter((s): s is string => !!s);
  if (!secrets.length) {
    if (env.PAYMENT_PROVIDER !== 'fake') throw new Error('NINEJAPAY_SECRET_KEY is required');
    secrets.push('whsec_fake');
  }
  instance =
    env.PAYMENT_PROVIDER === 'fake'
      ? new FakeProvider(secrets)
      : new NineJaPayProvider(
          {
            baseUrl: env.NINEJAPAY_BASE_URL,
            apiKey: env.NINEJAPAY_API_KEY as string,
            secretKey: env.NINEJAPAY_SECRET_KEY as string,
            businessAccountNumber: env.NINEJAPAY_BUSINESS_ACCOUNT_NUMBER as string,
            bankCode: env.NINEJAPAY_BANK_CODE,
            sandboxAuthKey: env.NINEJAPAY_SANDBOX_AUTH_KEY,
          },
          secrets,
        );
  return instance;
}

/** Test seam: swap the provider (e.g. for a FakeProvider with knobs set). */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  instance = provider;
}

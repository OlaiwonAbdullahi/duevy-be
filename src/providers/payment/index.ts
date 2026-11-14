import { env } from '../../config/env';
import { InterswitchProvider } from './interswitch/InterswitchProvider';
import { FakeProvider } from './fake/FakeProvider';
import { type PaymentProvider } from './types';

export * from './types';
export { FakeProvider } from './fake/FakeProvider';

let instance: PaymentProvider | null = null;

/** The configured payment rail (PAYMENT_PROVIDER). One instance per process. */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;

  if (env.PAYMENT_PROVIDER === 'fake') {
    // The public 'whsec_fake' secret is only acceptable under the fake rail;
    // a real rail must carry its own webhook secret.
    instance = new FakeProvider(['whsec_fake']);
    return instance;
  }

  instance = new InterswitchProvider({
    env: env.INTERSWITCH_ENV,
    clientId: env.INTERSWITCH_CLIENT_ID as string,
    clientSecret: env.INTERSWITCH_CLIENT_SECRET as string,
    merchantCode: env.INTERSWITCH_MERCHANT_CODE as string,
    payItemId: env.INTERSWITCH_PAY_ITEM_ID as string,
    currency: env.INTERSWITCH_CURRENCY,
    passportUrl: env.INTERSWITCH_PASSPORT_URL,
    collectionsUrl: env.INTERSWITCH_COLLECTIONS_URL,
    payoutsUrl: env.INTERSWITCH_PAYOUTS_URL,
    vaUrl: env.INTERSWITCH_VA_URL,
    inlineCheckoutUrl: env.INTERSWITCH_INLINE_CHECKOUT_URL,
    webhookSecret: env.INTERSWITCH_WEBHOOK_SECRET,
  });
  return instance;
}

/** Test seam: swap the provider (e.g. for a FakeProvider with knobs set). */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  instance = provider;
}

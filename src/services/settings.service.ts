import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { type CheckoutMode } from '../providers/payment';

/**
 * Platform-wide switches an admin can flip at runtime (platform_settings).
 *
 *  checkout_mode — how students pay a new checkout:
 *    'hosted'  redirect to the provider's checkout page (the default)
 *    'custom'  show a one-time bank account on Duevy's own pay page
 *  Changing it only affects checkouts opened afterwards; an open checkout keeps
 *  the mode it was created with.
 */

const CHECKOUT_MODE_KEY = 'checkout_mode';
export const CHECKOUT_MODES: readonly CheckoutMode[] = ['hosted', 'custom'];
const DEFAULT_CHECKOUT_MODE: CheckoutMode = 'hosted';

export interface PaymentSettings {
  checkoutMode: CheckoutMode;
  updatedAt: string | null;
  updatedById: string | null;
}

export async function getPaymentSettings(): Promise<PaymentSettings> {
  const row = await db.platformSetting.findUnique({ where: { key: CHECKOUT_MODE_KEY } });
  const stored = row?.value as unknown;
  return {
    checkoutMode: CHECKOUT_MODES.includes(stored as CheckoutMode) ? (stored as CheckoutMode) : DEFAULT_CHECKOUT_MODE,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedById: row?.updatedById ?? null,
  };
}

/** Read on every new checkout; cached briefly so it isn't a query each time. */
const CHECKOUT_MODE_TTL_MS = 30_000;
let cachedCheckoutMode: { mode: CheckoutMode; expiresAt: number } | null = null;

export async function getCheckoutMode(): Promise<CheckoutMode> {
  if (cachedCheckoutMode && cachedCheckoutMode.expiresAt > Date.now()) return cachedCheckoutMode.mode;
  const mode = (await getPaymentSettings()).checkoutMode;
  cachedCheckoutMode = { mode, expiresAt: Date.now() + CHECKOUT_MODE_TTL_MS };
  return mode;
}

export async function setCheckoutMode(mode: CheckoutMode, adminId: string): Promise<PaymentSettings> {
  const value = mode as Prisma.InputJsonValue;
  await db.platformSetting.upsert({
    where: { key: CHECKOUT_MODE_KEY },
    update: { value, updatedById: adminId },
    create: { key: CHECKOUT_MODE_KEY, value, updatedById: adminId },
  });
  cachedCheckoutMode = null;
  return getPaymentSettings();
}

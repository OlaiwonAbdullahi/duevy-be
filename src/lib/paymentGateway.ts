import { type PaymentGatewayName } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import * as monnify from './monnify';
import * as paystack from './paystack';

export type {
  InitTransactionInput,
  InitTransactionResult,
  MonnifyBank as GatewayBank,
  MonnifyTxnStatus as GatewayTxnStatus,
  MonnifyCardDetails as GatewayCardDetails,
  ChargeCardInput,
  ChargeCardResult,
  DisbursementInput,
  DisbursementResult,
  CreateSubaccountInput,
  SubaccountResult,
  CreateInvoiceInput,
  CreateInvoiceResult,
  RefundInput,
  RefundResult,
} from './monnify';

/**
 * Single switch point for which payment processor is live. Both
 * implementations (src/lib/monnify.ts, src/lib/paystack.ts) are complete and
 * kept working. The active one is stored in the AppSettings singleton row
 * (runtime-editable by a super_admin, see src/routes/admin.ts) rather than
 * baked into env at boot — PAYMENT_GATEWAY is only the fallback used the
 * first time this is read and if the row is ever missing. Nothing downstream
 * imports a concrete provider directly.
 */
const CACHE_TTL_MS = 15_000;
let cached: { value: PaymentGatewayName; expiresAt: number } | null = null;

function moduleFor(name: PaymentGatewayName) {
  return name === 'monnify' ? monnify : paystack;
}

/** Drop the cached gateway choice — called right after an admin changes it, so the new value takes effect immediately rather than after CACHE_TTL_MS. */
export function invalidateGatewayCache(): void {
  cached = null;
}

/** Which gateway is live right now — exported so callers can tag/compare stored gateway-specific data (e.g. BankAccount.bankCodeGateway) against it. */
export async function getActiveGatewayName(): Promise<PaymentGatewayName> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const row = await db.appSettings.findUnique({ where: { id: 'singleton' } });
  const value = row?.activePaymentGateway ?? env.PAYMENT_GATEWAY;
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Human-readable label for the active gateway — used on transaction/method fields. */
export async function getGatewayLabel(): Promise<'Paystack' | 'Monnify'> {
  const name = await getActiveGatewayName();
  return name === 'monnify' ? 'Monnify' : 'Paystack';
}

export async function initTransaction(...args: Parameters<typeof paystack.initTransaction>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).initTransaction(...args);
}

export async function verifyAccountName(...args: Parameters<typeof paystack.verifyAccountName>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).verifyAccountName(...args);
}

export async function getBanks(...args: Parameters<typeof paystack.getBanks>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).getBanks(...args);
}

export async function getTransactionStatus(...args: Parameters<typeof paystack.getTransactionStatus>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).getTransactionStatus(...args);
}

export async function getCardDetails(...args: Parameters<typeof paystack.getCardDetails>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).getCardDetails(...args);
}

export async function chargeCardToken(...args: Parameters<typeof paystack.chargeCardToken>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).chargeCardToken(...args);
}

export async function initiateDisbursement(...args: Parameters<typeof paystack.initiateDisbursement>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).initiateDisbursement(...args);
}

export async function getDisbursementStatus(...args: Parameters<typeof paystack.getDisbursementStatus>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).getDisbursementStatus(...args);
}

/** Paystack-only — throws on Monnify (see monnify.ts's stub) rather than silently no-op'ing. */
export async function createSubaccount(...args: Parameters<typeof paystack.createSubaccount>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).createSubaccount(...args);
}

export async function updateSubaccount(...args: Parameters<typeof paystack.updateSubaccount>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).updateSubaccount(...args);
}

/** Both gateways implement this — Monnify's dynamic Create Invoice, Paystack's Initialize Transaction + subaccount. */
export async function createInvoice(...args: Parameters<typeof paystack.createInvoice>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).createInvoice(...args);
}

/** Paystack-only — throws on Monnify (see monnify.ts's stub). */
export async function refundTransaction(...args: Parameters<typeof paystack.refundTransaction>) {
  const name = await getActiveGatewayName();
  return moduleFor(name).refundTransaction(...args);
}

/** Whether payout disbursement is configured for whichever gateway is active. */
export async function isDisbursementConfigured(): Promise<boolean> {
  const name = await getActiveGatewayName();
  return name === 'monnify' ? !!env.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT : !!env.PAYSTACK_SECRET_KEY;
}

/** Whether a given gateway has its required credentials present in env — checked before an admin is allowed to switch to it. */
export function isGatewayConfigured(name: PaymentGatewayName): boolean {
  if (name === 'monnify') {
    return !!(env.MONNIFY_API_KEY && env.MONNIFY_SECRET_KEY && env.MONNIFY_CONTRACT_CODE && env.MONNIFY_WEBHOOK_SECRET);
  }
  return !!env.PAYSTACK_SECRET_KEY;
}

import { randomInt } from 'crypto';

/**
 * Money helpers. Every amount in this codebase is an integer number of kobo
 * (₦1 = 100 kobo). No floats are ever used for arithmetic; the only place a
 * decimal appears is at the provider boundary, where Kredi takes and returns
 * naira decimals ("7000.00" or 7000) — see koboToDecimal / decimalToKobo.
 */

/** Convert kobo to naira (display / email templates only — never for arithmetic). */
export function koboToNaira(kobo: number): number {
  return kobo / 100;
}

/** Convert naira to kobo. */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

/** Format a kobo amount as a Nigerian naira string e.g. "₦7,500.00" */
export function formatNaira(kobo: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
  }).format(koboToNaira(kobo));
}

function assertKobo(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of kobo, got ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Provider boundary: kobo <-> decimal strings
// ---------------------------------------------------------------------------

/** 700000 → "7000.00". Pure integer/string math. */
export function koboToDecimal(kobo: number): string {
  assertKobo(kobo, 'amount');
  const naira = Math.floor(kobo / 100);
  const rem = kobo % 100;
  return `${naira}.${rem.toString().padStart(2, '0')}`;
}

/**
 * "7000.00" → 700000. Also accepts "7000", "7000.5" and a JSON number (some
 * Kredi responses render an amount as a bare number of naira). More than two
 * decimal places is rounded half-up to the kobo.
 */
export function decimalToKobo(value: string | number): number {
  const str = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) throw new RangeError(`not a non-negative decimal amount: ${JSON.stringify(value)}`);
  const whole = match[1] as string;
  const frac = (match[2] ?? '').padEnd(3, '0');
  let kobo = Number(whole) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) kobo += 1;
  if (!Number.isSafeInteger(kobo)) throw new RangeError(`amount out of range: ${JSON.stringify(value)}`);
  return kobo;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a non-negative amount: ${n}`);
  // toFixed(3) keeps a third digit for the half-up rule without exponent notation.
  return n.toFixed(3);
}

// ---------------------------------------------------------------------------
// Fees (server-side only — never accepted from a client)
// ---------------------------------------------------------------------------

/**
 * Checkout service charge, paid by the student on top: 1.5% of the basket plus
 * a flat ₦20 (which covers Kredi's ₦20 inward fee), capped at ₦250 in total.
 * The cap bites from a basket of about ₦15,334.
 */
export const CHECKOUT_FEE_BASIS_POINTS = 150; // 1.5%
export const CHECKOUT_FEE_FLAT_KOBO = 2_000; // ₦20
export const CHECKOUT_FEE_CAP_KOBO = 25_000; // ₦250

/**
 * Withdrawal fee, deducted from the withdrawal, tiered to track Kredi's own
 * transfer cost. Tiers are inclusive of `maxKobo`; the last has no ceiling.
 *   under ₦10,000          ₦50
 *   ₦10,000 to ₦50,000     ₦120
 *   above ₦50,000          ₦200
 */
export interface WithdrawalFeeTier {
  /** Inclusive upper bound of the gross; null for the top tier. */
  maxKobo: number | null;
  feeKobo: number;
}
export const WITHDRAWAL_FEE_TIERS: readonly WithdrawalFeeTier[] = [
  { maxKobo: 999_999, feeKobo: 5_000 },
  { maxKobo: 5_000_000, feeKobo: 12_000 },
  { maxKobo: null, feeKobo: 20_000 },
];

/** What Kredi charges us. Used for revenue reporting only — never charged to anyone. */
export const KREDI_INWARD_COST_KOBO = 2_000; // ₦20 per payment received

/**
 * Kredi's cost of one outward transfer of `amountKobo` (stamp duty assumed at
 * ₦50 from ₦10,000 — confirm with Kredi). Intra-Kredi transfers are free.
 */
export function krediPayoutCostKobo(amountKobo: number): number {
  assertKobo(amountKobo, 'amountKobo');
  if (amountKobo < 500_000) return 1_000; // ₦10
  if (amountKobo < 1_000_000) return 2_500; // ₦25
  if (amountKobo <= 5_000_000) return 7_500; // ₦25 + stamp duty
  return 10_000; // ₦50 + stamp duty
}

/** No withdrawal below ₦1,000. */
export const MIN_PAYOUT_KOBO = 100_000;

/** round(a × num / den), half-up, in integers. */
function mulDivRoundHalfUp(a: number, num: number, den: number): number {
  return Math.floor((a * num * 2 + den) / (den * 2));
}

/**
 * The service charge for one checkout covering `faceKobo` worth of dues.
 * Charged ONCE per checkout: the ₦20 flat does not multiply per due, and the
 * ₦250 cap applies to the whole checkout.
 */
export function checkoutFee(faceKobo: number): number {
  assertKobo(faceKobo, 'faceKobo');
  if (faceKobo === 0) return 0;
  const fee = mulDivRoundHalfUp(faceKobo, CHECKOUT_FEE_BASIS_POINTS, 10_000) + CHECKOUT_FEE_FLAT_KOBO;
  return Math.min(fee, CHECKOUT_FEE_CAP_KOBO);
}

export interface Charge {
  /** What the space receives — the full face amount. */
  face: number;
  /** Duevy's service charge, on top. */
  fee: number;
  /** What the student transfers. */
  total: number;
}

export function computeCharge(faceKobo: number): Charge {
  const fee = checkoutFee(faceKobo);
  return { face: faceKobo, fee, total: faceKobo + fee };
}

/**
 * Split `total` across `weights` proportionally, largest-remainder method, so
 * the parts are integers that sum exactly to `total`. Used to spread one
 * checkout's fee across the dues it covers for per-due reporting.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertKobo(total, 'total');
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    const even = weights.map(() => Math.floor(total / weights.length));
    even[0] = (even[0] as number) + (total - even.reduce((a, b) => a + b, 0));
    return even;
  }
  // BigInt so total × weight can't lose precision on large amounts.
  const T = BigInt(total);
  const S = BigInt(sum);
  const parts = weights.map((w) => (T * BigInt(w)) / S);
  const rems = weights.map((w, i) => ({ i, rem: (T * BigInt(w)) % S }));
  let left = T - parts.reduce((a, b) => a + b, 0n);
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of rems) {
    if (left <= 0n) break;
    parts[i] = (parts[i] as bigint) + 1n;
    left -= 1n;
  }
  return parts.map(Number);
}

export function withdrawalFee(grossKobo: number): number {
  assertKobo(grossKobo, 'grossKobo');
  const tier = WITHDRAWAL_FEE_TIERS.find((t) => t.maxKobo === null || grossKobo <= t.maxKobo);
  return (tier as WithdrawalFeeTier).feeKobo;
}

export interface WithdrawalBreakdown {
  /** Debited from the space's ledger. */
  gross: number;
  /** Duevy's withdrawal fee, deducted from the gross (after any partner discount). */
  fee: number;
  /** The fee before the partner discount. */
  feeBeforeDiscount: number;
  /** Partner discount taken off the fee. */
  discount: number;
  /** What lands in the rep's bank account. */
  net: number;
}

/** The withdrawal fee with a partner's percentage discount applied (discount rounded half-up). */
export function discountedFee(feeKobo: number, discountPercent: number): number {
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError(`discountPercent must be an integer 0–100, got ${discountPercent}`);
  }
  return feeKobo - mulDivRoundHalfUp(feeKobo, discountPercent, 100);
}

export function computeWithdrawal(grossKobo: number, discountPercent = 0): WithdrawalBreakdown {
  const feeBeforeDiscount = withdrawalFee(grossKobo);
  const fee = discountedFee(feeBeforeDiscount, discountPercent);
  return { gross: grossKobo, fee, feeBeforeDiscount, discount: feeBeforeDiscount - fee, net: grossKobo - fee };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function randomChunk(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return out;
}

/** Checkout / transaction reference, e.g. DVY-7KQ2-MN4X. */
export function generateReference(prefix = 'DVY'): string {
  return `${prefix}-${randomChunk(4)}-${randomChunk(4)}`;
}

/** Withdrawal reference, e.g. WD-2026-7KQ2MN. */
export function generatePayoutReference(): string {
  return `WD-${new Date().getUTCFullYear()}-${randomChunk(6)}`;
}

/** Receipt number, e.g. RCT-2026-7KQ2MN4X. */
export function generateReceiptNumber(): string {
  return `RCT-${new Date().getUTCFullYear()}-${randomChunk(8)}`;
}

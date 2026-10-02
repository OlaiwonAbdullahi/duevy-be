import { randomInt } from 'crypto';

/**
 * Money helpers. Every amount in this codebase is an integer number of kobo
 * (₦1 = 100 kobo). No floats are ever used for arithmetic; the only place a
 * decimal appears is at the provider boundary, where Bachs takes and returns
 * decimal strings ("7000.00") — see koboToDecimal / decimalToKobo.
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
 * Bachs responses render an amount as a bare number of naira). More than two
 * decimal places is rounded half-up to the kobo, matching how Bachs stores it.
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

/** Checkout service charge: 2% of the basket, plus a flat ₦20, paid by the student on top. */
export const CHECKOUT_FEE_PERCENT = 2;
export const CHECKOUT_FEE_FLAT_KOBO = 2_000; // ₦20

/** Withdrawal fee: ₦100 under ₦50,000, ₦200 at ₦50,000 and above, deducted from the withdrawal. */
export const WITHDRAWAL_FEE_LOW_KOBO = 10_000; // ₦100
export const WITHDRAWAL_FEE_HIGH_KOBO = 20_000; // ₦200
export const WITHDRAWAL_FEE_THRESHOLD_KOBO = 5_000_000; // ₦50,000

/** No withdrawal below ₦1,000. */
export const MIN_PAYOUT_KOBO = 100_000;

/** round(a × num / den), half-up, in integers. */
function mulDivRoundHalfUp(a: number, num: number, den: number): number {
  return Math.floor((a * num * 2 + den) / (den * 2));
}

/**
 * The service charge for one checkout covering `faceKobo` worth of dues.
 * Charged ONCE per checkout: the ₦20 flat does not multiply per due.
 */
export function checkoutFee(faceKobo: number): number {
  assertKobo(faceKobo, 'faceKobo');
  if (faceKobo === 0) return 0;
  return mulDivRoundHalfUp(faceKobo, CHECKOUT_FEE_PERCENT, 100) + CHECKOUT_FEE_FLAT_KOBO;
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
  return grossKobo < WITHDRAWAL_FEE_THRESHOLD_KOBO ? WITHDRAWAL_FEE_LOW_KOBO : WITHDRAWAL_FEE_HIGH_KOBO;
}

export interface WithdrawalBreakdown {
  /** Debited from the space's ledger. */
  gross: number;
  /** Duevy's withdrawal fee, deducted from the gross. */
  fee: number;
  /** What lands in the rep's bank account. */
  net: number;
}

export function computeWithdrawal(grossKobo: number): WithdrawalBreakdown {
  const fee = withdrawalFee(grossKobo);
  return { gross: grossKobo, fee, net: grossKobo - fee };
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

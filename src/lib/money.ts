import { randomInt } from 'crypto';

/**
 * Money helpers. Every amount in this codebase is an integer number of kobo
 * (₦1 = 100 kobo). No floats are ever used for arithmetic; the only place a
 * decimal appears where an amount is shown or parsed as naira ("7000.00") —
 * see koboToDecimal / decimalToKobo. 9jaPay itself works in kobo.
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
 * "7000.00" → 700000. Also accepts "7000", "7000.5" and a JSON number of
 * naira. More than two decimal places is rounded half-up to the kobo.
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
 * Checkout processing fee: 1.5% of the basket, paid by the student on top.
 * Duevy takes no margin; the fee covers 9jaPay's charges on the student's
 * transfer (0.5%, capped at ₦750, plus ₦50 stamp duty from ₦10,000) and on
 * the sweep of that money into the space's own account.
 */
export const COLLECTION_FEE_BPS = 150;

/**
 * 9jaPay adds 7.5% VAT on its transfer charge, debited from the sender as a
 * separate line (live, 2026-11-09: a ₦1,900 transfer cost ₦10 + ₦0.75 VAT).
 * Rounded up so the ledger never debits less than the account loses.
 */
const withVat = (chargeKobo: number) => chargeKobo + Math.ceil((chargeKobo * 75) / 1000);

/**
 * Withdrawal fee: 9jaPay's transfer charge plus VAT, passed on and deducted
 * from the withdrawal. ₦10.75 under ₦5,000, ₦16.13 under ₦100,000, ₦21.50
 * from ₦100,000.
 */
export const TRANSFER_FEE_BANDS: { belowKobo: number; feeKobo: number }[] = [
  { belowKobo: 500_000, feeKobo: withVat(1_000) }, // < ₦5,000 → ₦10 + VAT
  { belowKobo: 10_000_000, feeKobo: withVat(1_500) }, // < ₦100,000 → ₦15 + VAT
];
export const TRANSFER_FEE_TOP_KOBO = withVat(2_000); // ₦20 + VAT

/** No withdrawal below ₦1,000. */
export const MIN_PAYOUT_KOBO = 100_000;
/** No single withdrawal above ₦500,000. */
export const MAX_PAYOUT_KOBO = 50_000_000;
/** A space withdraws at most ₦5,000,000 a day (Africa/Lagos days). */
export const DAILY_PAYOUT_LIMIT_KOBO = 500_000_000;
/** 9jaPay refuses any single transfer above ₦1,000,000, so sweeps are split. */
export const MAX_TRANSFER_KOBO = 100_000_000;

/** The processing fee for one checkout covering `faceKobo` worth of dues, rounded up to the kobo. */
export function checkoutFee(faceKobo: number): number {
  assertKobo(faceKobo, 'faceKobo');
  return Math.ceil((faceKobo * COLLECTION_FEE_BPS) / 10_000);
}

export interface Charge {
  /** What the space receives — the full face amount. */
  face: number;
  /** The processing fee, on top. */
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

/** 9jaPay's charge for one transfer of `amountKobo`. */
export function transferFee(amountKobo: number): number {
  assertKobo(amountKobo, 'amountKobo');
  return TRANSFER_FEE_BANDS.find((b) => amountKobo < b.belowKobo)?.feeKobo ?? TRANSFER_FEE_TOP_KOBO;
}

export function withdrawalFee(grossKobo: number): number {
  return transferFee(grossKobo);
}

export interface WithdrawalBreakdown {
  /** Debited from the space's ledger. */
  gross: number;
  /** The transfer fee, deducted from the gross. */
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

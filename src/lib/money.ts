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
export const vatOnCharge = (chargeKobo: number) => Math.ceil((chargeKobo * 75) / 1000);

/** 9jaPay's transfer charge before VAT: ₦10 under ₦5,000, ₦15 under ₦100,000, ₦20 from ₦100,000. */
const TRANSFER_CHARGE_BANDS = [
  { belowKobo: 500_000, chargeKobo: 1_000 },
  { belowKobo: 10_000_000, chargeKobo: 1_500 },
];
const TRANSFER_CHARGE_TOP_KOBO = 2_000;

/**
 * Withdrawal fee: 9jaPay's transfer charge plus VAT, passed on and deducted
 * from the withdrawal. ₦10.75 under ₦5,000, ₦16.13 under ₦100,000, ₦21.50
 * from ₦100,000.
 */
export const TRANSFER_FEE_BANDS: { belowKobo: number; chargeKobo: number; vatKobo: number; feeKobo: number }[] =
  TRANSFER_CHARGE_BANDS.map((b) => ({ ...b, vatKobo: vatOnCharge(b.chargeKobo), feeKobo: b.chargeKobo + vatOnCharge(b.chargeKobo) }));
export const TRANSFER_FEE_TOP = {
  chargeKobo: TRANSFER_CHARGE_TOP_KOBO,
  vatKobo: vatOnCharge(TRANSFER_CHARGE_TOP_KOBO),
  feeKobo: TRANSFER_CHARGE_TOP_KOBO + vatOnCharge(TRANSFER_CHARGE_TOP_KOBO),
};
export const TRANSFER_FEE_TOP_KOBO = TRANSFER_FEE_TOP.feeKobo;

/**
 * A stored withdrawal fee split into 9jaPay's charge and the VAT on it.
 * Withdrawals from before VAT was passed on (2026-11-09) hold the bare
 * charge, so a fee matching no band is all charge.
 */
export function splitWithdrawalFee(feeKobo: number): { chargeKobo: number; vatKobo: number } {
  const band = [...TRANSFER_FEE_BANDS, TRANSFER_FEE_TOP].find((b) => b.feeKobo === feeKobo);
  return band ? { chargeKobo: band.chargeKobo, vatKobo: band.vatKobo } : { chargeKobo: feeKobo, vatKobo: 0 };
}

/** No withdrawal below ₦1,000. */
export const MIN_PAYOUT_KOBO = 100_000;
/** No single withdrawal above ₦500,000. */
export const MAX_PAYOUT_KOBO = 50_000_000;
/** A space withdraws at most ₦5,000,000 a day (Africa/Lagos days). */
export const DAILY_PAYOUT_LIMIT_KOBO = 500_000_000;
/** 9jaPay refuses any single transfer above ₦1,000,000, so sweeps are split. */
export const MAX_TRANSFER_KOBO = 100_000_000;

/**
 * The collection fee rate for a space, in basis points: its own override, or
 * the default COLLECTION_FEE_BPS when it has none. This is the single place the
 * per-space rate is resolved, so every caller charges and previews the same.
 */
export function feeBpsForSpace(space: { collectionFeeBps?: number | null }): number {
  return space.collectionFeeBps ?? COLLECTION_FEE_BPS;
}

/**
 * The processing fee for one checkout covering `faceKobo` worth of dues, rounded
 * up to the kobo. `feeBps` is the space's rate (see `feeBpsForSpace`); it
 * defaults to the standard rate for callers with no space in scope.
 */
export function checkoutFee(faceKobo: number, feeBps: number = COLLECTION_FEE_BPS): number {
  assertKobo(faceKobo, 'faceKobo');
  return Math.ceil((faceKobo * feeBps) / 10_000);
}

/**
 * What 9jaPay actually takes out of a collection, which Duevy's profit is its
 * processing fee minus.
 *
 * Verified against the live 9jaPay transaction ledger (2026-11-26): collections
 * settle into the business account with NO charge — across every
 * "VIRTUAL ACCOUNT CLOSURE TRANSFER" into it, 9jaPay billed ₦0. The 0.5%
 * (capped ₦750, + ₦50 stamp duty from ₦10,000) that 9jaPay quotes is not being
 * charged on the inflow, so Duevy keeps the entire processing fee on a
 * collection. Hence the rate is 0 and this returns 0.
 *
 * If 9jaPay begins billing the collection fee, set PROVIDER_COLLECTION_FEE_BPS
 * back to 50: the cap and stamp duty below then take effect. Note that it must
 * then be summed PER CHECKOUT (not applied to an aggregate total), or the ₦750
 * cap and the per-transaction ₦50 stamp duty come out wrong.
 */
export const PROVIDER_COLLECTION_FEE_BPS = 0;
/** 9jaPay's quoted collection pricing, used only when the rate above is non-zero. */
const PROVIDER_COLLECTION_FEE_CAP_KOBO = 75_000; // ₦750 cap on the percentage
const PROVIDER_STAMP_DUTY_KOBO = 5_000; // ₦50 stamp duty
const PROVIDER_STAMP_DUTY_FROM_KOBO = 1_000_000; // charged from ₦10,000 up

export function providerCollectionFee(amountKobo: number): number {
  assertKobo(amountKobo, 'amountKobo');
  if (PROVIDER_COLLECTION_FEE_BPS === 0) return 0;
  const pct = Math.min(Math.ceil((amountKobo * PROVIDER_COLLECTION_FEE_BPS) / 10_000), PROVIDER_COLLECTION_FEE_CAP_KOBO);
  const stamp = amountKobo >= PROVIDER_STAMP_DUTY_FROM_KOBO ? PROVIDER_STAMP_DUTY_KOBO : 0;
  return pct + stamp;
}

export interface Charge {
  /** What the space receives — the full face amount. */
  face: number;
  /** The processing fee, on top. */
  fee: number;
  /** What the student transfers. */
  total: number;
}

export function computeCharge(faceKobo: number, feeBps: number = COLLECTION_FEE_BPS): Charge {
  return computeChargeFor(faceKobo, true, feeBps);
}

/**
 * The charge for a due whose fee the student may or may not bear.
 *   studentBearsFee — the student pays the fee on top (`fee` > 0, total = face + fee).
 *   !studentBearsFee — the space absorbs it: the student pays only the face,
 *                      so `fee` is 0 here (what the student pays on top) and the
 *                      space is credited face − checkoutFee(face) instead.
 */
export function computeChargeFor(faceKobo: number, studentBearsFee: boolean, feeBps: number = COLLECTION_FEE_BPS): Charge {
  const fee = studentBearsFee ? checkoutFee(faceKobo, feeBps) : 0;
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
  /** The transfer fee (charge + VAT), deducted from the gross. */
  fee: number;
  /** 9jaPay's transfer charge, part of `fee`. */
  charge: number;
  /** 7.5% VAT on the charge, part of `fee`. */
  vat: number;
  /** What lands in the rep's bank account. */
  net: number;
}

export function computeWithdrawal(grossKobo: number): WithdrawalBreakdown {
  const fee = withdrawalFee(grossKobo);
  const { chargeKobo, vatKobo } = splitWithdrawalFee(fee);
  return { gross: grossKobo, fee, charge: chargeKobo, vat: vatKobo, net: grossKobo - fee };
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

/**
 * Money helpers — all amounts are stored and transmitted as kobo (₦1 = 100 kobo).
 */

/** Convert kobo to naira (for display / email templates). */
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

/**
 * Compute the 3% processing charge for a due, added ON TOP of the face amount.
 *
 * The rep sets the face amount and receives it in full; the payer covers the
 * charge. e.g. face ₦5,000 → payer is charged ₦5,150, space nets ₦5,000.
 *
 *  - 1.5% Monnify fee + 1.5% Duevy platform fee, each rounded half-up on the face.
 *  - `totalCharged` is what the payer pays; `netToSpace` is the untouched face.
 *
 * Note: `netToSpace === totalCharged - totalFee` still holds, so the DuePayment
 * invariant (net = amountPaid − fees) is preserved.
 */
/** Total processing-fee rate (both halves combined) — also what a rep's Paystack subaccount is created with as its default `percentage_charge`, per-transaction overrides aside. */
export const PLATFORM_PERCENTAGE_CHARGE = 3;

/**
 * `discountKobo` (a redeemed referral DiscountCode, see referral.service.ts)
 * reduces what the payer is charged, capped at `totalFee` — Duevy's own
 * platform cut absorbs the discount; the rep's `netToSpace` is always the
 * untouched face value regardless of any discount applied.
 */
export function computeCharge(faceKobo: number, discountKobo = 0): {
  face: number;
  monnifyFee: number;
  duevyFee: number;
  totalFee: number;
  totalCharged: number;
  netToSpace: number;
  discountApplied: number;
} {
  const monnifyFee = Math.round(faceKobo * 0.015);
  const duevyFee = Math.round(faceKobo * 0.015);
  const totalFee = monnifyFee + duevyFee;
  const discountApplied = Math.max(0, Math.min(discountKobo, totalFee));
  return {
    face: faceKobo,
    monnifyFee,
    duevyFee,
    totalFee,
    totalCharged: faceKobo + totalFee - discountApplied,
    netToSpace: faceKobo,
    discountApplied,
  };
}

/**
 * Split config to pass into a Paystack subaccount charge so the rep's space
 * settles `netToSpace` directly and Duevy keeps the fee — kept separate from
 * `computeCharge()`, which stays authoritative for what the payer is charged
 * and what gets recorded on `DuePayment`. This function only describes what
 * to *tell Paystack*.
 *
 * UNVERIFIED — confirm against Paystack's live API docs before wiring this
 * into a real charge call:
 *  - whether a flat `transaction_charge` (kobo) lets the platform take an
 *    exact amount with the subaccount getting the remainder, vs. being
 *    locked into `percentage_charge` fixed at subaccount-creation time
 *  - whether `bearer` should be 'account' (Duevy) or 'subaccount' (rep) —
 *    determines whether the rep nets exactly `netToSpace` or slightly less
 *  - whether split config can be overridden per-transaction at all
 */
export function computeSubaccountSplit(faceKobo: number): {
  subaccountShareKobo: number; // what the rep's subaccount should receive — always netToSpace
  platformShareKobo: number; // what Duevy keeps — always totalFee
  bearer: 'account'; // Duevy absorbs Paystack's own processing fee, not the rep — VERIFY this is actually configurable this way
} {
  const { totalFee, netToSpace } = computeCharge(faceKobo);
  return {
    subaccountShareKobo: netToSpace,
    platformShareKobo: totalFee,
    bearer: 'account',
  };
}

/** Generate a unique transaction reference in the format DVY-XXXX-XXXX */
export function generateReference(prefix = 'DVY'): string {
  const part1 = Math.floor(1000 + Math.random() * 9000);
  const part2 = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${part1}-${part2}`;
}

/** Generate a payout reference e.g. PAY-2026-0642 */
export function generatePayoutReference(): string {
  const year = new Date().getFullYear();
  const seq = Math.floor(100 + Math.random() * 9900)
    .toString()
    .padStart(4, '0');
  return `PAY-${year}-${seq}`;
}

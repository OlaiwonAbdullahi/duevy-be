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
 *  - 1.5% processing fee + 1.5% Duevy platform fee, each rounded half-up on the face.
 *  - `totalCharged` is what the payer pays; `netToSpace` is the untouched face.
 *
 * Note: `netToSpace === totalCharged - totalFee` still holds, so the DuePayment
 * invariant (net = amountPaid − fees) is preserved.
 */
export const PLATFORM_PERCENTAGE_CHARGE = 3;

/**
 * `discountKobo` (a redeemed referral DiscountCode, see referral.service.ts)
 * reduces what the payer is charged, capped at `totalFee` — Duevy's own
 * platform cut absorbs the discount; the rep's `netToSpace` is always the
 * untouched face value regardless of any discount applied.
 */
export function computeCharge(faceKobo: number, discountKobo = 0): {
  face: number;
  processingFee: number;
  duevyFee: number;
  totalFee: number;
  totalCharged: number;
  netToSpace: number;
  discountApplied: number;
} {
  const processingFee = Math.round(faceKobo * 0.015);
  const duevyFee = Math.round(faceKobo * 0.015);
  const totalFee = processingFee + duevyFee;
  const discountApplied = Math.max(0, Math.min(discountKobo, totalFee));
  return {
    face: faceKobo,
    processingFee,
    duevyFee,
    totalFee,
    totalCharged: faceKobo + totalFee - discountApplied,
    netToSpace: faceKobo,
    discountApplied,
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

/**
 * Kobo <-> decimal-naira-string conversion for the Bachs API, which takes
 * amounts as decimal strings at currency precision ("7000.00"), never a JS
 * number (see .claude/skills/bachs-connect/SKILL.md's non-negotiables).
 * Integer-only arithmetic throughout — no parseFloat/toFixed float rounding.
 */
export function koboToDecimalString(kobo: number): string {
  const naira = Math.trunc(kobo / 100);
  const remainderKobo = Math.abs(kobo % 100);
  return `${kobo < 0 && naira === 0 ? '-0' : naira}.${remainderKobo.toString().padStart(2, '0')}`;
}

export function decimalStringToKobo(value: string): number {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`decimalStringToKobo: "${value}" is not a valid decimal amount string`);
  const [, sign, naira, kobo] = match;
  const magnitude = Number(naira) * 100 + Number(kobo);
  return sign === '-' ? -magnitude : magnitude;
}

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
 * The service charge, added ON TOP of the face amount (PRD §7.1).
 *
 * The rep sets the face amount and receives it in full; the payer covers the
 * charge. e.g. face ₦5,000 → payer is charged ₦5,100, space nets ₦5,000.
 * "Your ₦5,000 due stays ₦5,000" is the pitch to the rep, and it stays true.
 *
 * The 2% is INCLUSIVE of Anchor's own collection cut — Duevy does not stack
 * Anchor's 0.5% on top of it. That is why the charge splits across
 * DuePayment's two fee columns rather than needing new ones:
 *
 *   processingFee — what Anchor is expected to take (0.5% capped at ₦500,
 *                   plus ₦50 stamp duty above ₦10,000)
 *   duevyFee      — whatever is left of the 2%, i.e. Duevy's actual margin
 */
export const SERVICE_CHARGE_PERCENT = 2;

/** Anchor's inflow pricing on a collection: 0.5%, capped at ₦500. */
const ANCHOR_COLLECTION_RATE = 0.005;
const ANCHOR_COLLECTION_CAP_KOBO = 50_000; // ₦500

/** CBN stamp duty: a flat ₦50 on any transfer above ₦10,000, in or out. */
export const STAMP_DUTY_KOBO = 5_000; // ₦50
export const STAMP_DUTY_THRESHOLD_KOBO = 1_000_000; // ₦10,000

/** Anchor's NIP transfer price, which the rep's withdrawal fee covers. */
export const ANCHOR_NIP_FEE_KOBO = 5_000; // ₦50
/** Duevy's own margin on a withdrawal. Together with the NIP fee this is the "₦100 flat" of PRD §7.1. */
export const DUEVY_PAYOUT_FEE_KOBO = 5_000; // ₦50
/** PRD §6.5 — no withdrawal below ₦1,000. */
export const MIN_PAYOUT_KOBO = 100_000; // ₦1,000

/**
 * Anchor TIER_2 (BVN) balance ceiling for a rep's own deposit account.
 *
 * The matching SINGLE-DEPOSIT limit is deliberately absent: students now pay
 * into Duevy's settlement account, which Anchor confirmed has no limit, so a
 * due of any size can be collected. What still lands in the rep's TIER_2
 * account is the remittance, and whether an inbound book transfer counts
 * against this ceiling is UNCONFIRMED — the warning in payouts.ts stays until
 * Anchor answers.
 */
export const TIER2_BALANCE_CEILING_KOBO = 30_000_000; // ₦300,000

/**
 * The balance ceiling that applies to a rep at a given verified tier.
 *
 * `null` means there is no ceiling. **tier_3 is unlimited** — that is the whole
 * point of the upgrade, and the answer to the ₦300,000 problem in PRD §3.4: a
 * space that outgrows tier_2 pays ₦200 once and stops having a ceiling at all.
 * Callers must handle null by hiding the warning entirely, never by falling
 * back to the tier_2 number.
 *
 * tier_0 shares the tier_2 ceiling because an unverified rep cannot hold a
 * balance at all — the account does not exist until KYC passes — so the value
 * is only ever a display default.
 */
export function balanceCeilingFor(tier: 'tier_0' | 'tier_2' | 'tier_3'): number | null {
  return tier === 'tier_3' ? null : TIER2_BALANCE_CEILING_KOBO;
}

export function stampDutyFor(amountKobo: number): number {
  return amountKobo > STAMP_DUTY_THRESHOLD_KOBO ? STAMP_DUTY_KOBO : 0;
}

export interface Charge {
  face: number;
  processingFee: number;
  duevyFee: number;
  totalFee: number;
  totalCharged: number;
  netToSpace: number;
  discountApplied: number;
}

/**
 * `discountKobo` (a redeemed referral DiscountCode, see referral.service.ts)
 * reduces what the payer is charged, capped at the service charge — Duevy's own
 * margin absorbs the discount; the rep's `netToSpace` is always the untouched
 * face value regardless of any discount applied.
 *
 * `totalFee` is net of the discount, so the DuePayment invariant
 * `netToSpace === totalCharged − processingFee − duevyFee` holds under a
 * discount too (the pre-Anchor implementation quietly broke it there).
 */
export function computeCharge(faceKobo: number, discountKobo = 0): Charge {
  const serviceCharge = Math.round(faceKobo * (SERVICE_CHARGE_PERCENT / 100));
  const discountApplied = Math.max(0, Math.min(discountKobo, serviceCharge));
  const totalCharged = faceKobo + serviceCharge - discountApplied;
  const totalFee = serviceCharge - discountApplied;

  // Anchor's cut is levied on what the payer actually sends, not on the face.
  const anchorCut =
    Math.min(Math.round(totalCharged * ANCHOR_COLLECTION_RATE), ANCHOR_COLLECTION_CAP_KOBO) +
    stampDutyFor(totalCharged);

  // A heavily discounted charge can cost Duevy more than it collects; the fee
  // split never goes negative, so processingFee absorbs whatever is left.
  const processingFee = Math.min(anchorCut, totalFee);

  return {
    face: faceKobo,
    processingFee,
    duevyFee: totalFee - processingFee,
    totalFee,
    totalCharged,
    netToSpace: faceKobo,
    discountApplied,
  };
}

export interface PayoutFees {
  duevyFeeKobo: number;
  anchorFeeKobo: number;
  stampDutyKobo: number;
  netSentKobo: number;
}

/**
 * Splits a withdrawal into what the rep is charged and what actually lands
 * (PRD §7.3). The requested `amountKobo` is the GROSS debit against the space's
 * available balance and everything comes out of it, so the account reconciles
 * exactly: `netSent` leaves as the NIP transfer, Anchor deducts its own
 * TRANSFER_FEE and STAMP_DUTY as separate CustomerFee rows, and Duevy's margin
 * is swept by book transfer.
 *
 * Surface this to the rep as "Duevy fee ₦100 + stamp duty ₦50" — the ₦100 is
 * `duevyFeeKobo + anchorFeeKobo`, which is what §7.1 calls the flat fee.
 */
export function computePayoutFees(amountKobo: number): PayoutFees {
  const stampDutyKobo = stampDutyFor(amountKobo);
  return {
    duevyFeeKobo: DUEVY_PAYOUT_FEE_KOBO,
    anchorFeeKobo: ANCHOR_NIP_FEE_KOBO,
    stampDutyKobo,
    netSentKobo: amountKobo - DUEVY_PAYOUT_FEE_KOBO - ANCHOR_NIP_FEE_KOBO - stampDutyKobo,
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

// koboToDecimalString/decimalStringToKobo lived here for Bachs, which took
// amounts as decimal strings ("7000.00"). Anchor takes integer minor units
// throughout, so kobo goes over the wire unchanged and the conversion is gone.

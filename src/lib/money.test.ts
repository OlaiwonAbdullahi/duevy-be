import { describe, expect, it } from 'vitest';
import {
  computeCharge,
  computePayoutFees,
  MIN_PAYOUT_KOBO,
  STAMP_DUTY_KOBO,
} from './money';

const NAIRA = 100;

describe('computeCharge', () => {
  it('adds a 2% service charge on top and leaves the face amount whole', () => {
    const c = computeCharge(5_000 * NAIRA);
    expect(c.face).toBe(500_000);
    expect(c.totalCharged).toBe(510_000); // ₦5,100
    expect(c.netToSpace).toBe(500_000); // "your ₦5,000 due stays ₦5,000"
    expect(c.totalFee).toBe(10_000); // ₦100
  });

  it('splits the 2% into Anchor\'s expected cut and Duevy\'s margin', () => {
    // ₦5,100 sent -> Anchor takes 0.5% = ₦25.50, no stamp duty under ₦10,000.
    const c = computeCharge(5_000 * NAIRA);
    expect(c.processingFee).toBe(2_550);
    expect(c.duevyFee).toBe(7_450); // ₦74.50, matching PRD §7.2
  });

  it('includes stamp duty in the Anchor cut above ₦10,000', () => {
    const under = computeCharge(9_000 * NAIRA); // ₦9,180 charged
    const over = computeCharge(20_000 * NAIRA); // ₦20,400 charged
    expect(under.processingFee).toBe(Math.round(918_000 * 0.005));
    expect(over.processingFee).toBe(Math.round(2_040_000 * 0.005) + STAMP_DUTY_KOBO);
    expect(over.duevyFee).toBe(40_000 - over.processingFee); // ₦248, matching PRD §7.2
  });

  it('caps Anchor\'s percentage cut at ₦500', () => {
    // 0.5% only reaches ₦500 at ₦100,000, above the tier ceiling — so assert
    // the cap directly rather than pretending such a charge is reachable.
    const huge = computeCharge(1_000_000 * NAIRA);
    expect(huge.processingFee).toBe(50_000 + STAMP_DUTY_KOBO);
  });

  it('holds the DuePayment invariant with and without a discount', () => {
    for (const [face, discount] of [
      [500_000, 0],
      [500_000, 4_000],
      [500_000, 10_000],
      [500_000, 999_999], // over-large discount, must clamp
      [2_040_000, 5_000],
      [10_000, 0],
    ] as const) {
      const c = computeCharge(face, discount);
      expect(c.netToSpace, `face=${face} discount=${discount}`).toBe(
        c.totalCharged - c.processingFee - c.duevyFee,
      );
      expect(c.processingFee).toBeGreaterThanOrEqual(0);
      expect(c.duevyFee).toBeGreaterThanOrEqual(0);
    }
  });

  it('caps the discount at the service charge, absorbing it from Duevy\'s margin', () => {
    const full = computeCharge(500_000, 999_999);
    expect(full.discountApplied).toBe(10_000); // never more than the 2%
    expect(full.totalCharged).toBe(500_000); // payer pays the face only
    expect(full.netToSpace).toBe(500_000); // the rep is untouched by the discount
    expect(full.totalFee).toBe(0);
  });

  // Under Pay With Transfer the whole charge lands in Duevy's settlement
  // account and only `netToSpace` is remitted on to the rep. Duevy's margin is
  // therefore exactly what stays behind — and it must never include
  // `processingFee`, which is Anchor's own cut and is charged separately
  // against the settlement account.
  it('leaves exactly duevyFee behind when netToSpace is remitted', () => {
    for (const face of [200_000, 500_000, 2_000_000, 5_000_000, 20_000_000]) {
      const c = computeCharge(face);
      expect(c.totalCharged - c.netToSpace).toBe(c.totalFee);
      expect(c.totalFee - c.processingFee).toBe(c.duevyFee);
      // The rep receives the face value untouched, whatever the ticket size.
      expect(c.netToSpace).toBe(face);
    }
  });

  it('has no single-deposit cap — the settlement account is unlimited', () => {
    const huge = computeCharge(100_000_000); // ₦1,000,000, well past any TIER_2 limit
    expect(huge.netToSpace).toBe(100_000_000);
    expect(huge.totalCharged).toBe(102_000_000);
  });
});

describe('computePayoutFees', () => {
  it('charges ₦100 with no stamp duty at or below ₦10,000', () => {
    const f = computePayoutFees(8_000 * NAIRA);
    expect(f.duevyFeeKobo + f.anchorFeeKobo).toBe(10_000); // the "₦100 flat"
    expect(f.stampDutyKobo).toBe(0);
    expect(f.netSentKobo).toBe(800_000 - 10_000);
  });

  it('adds ₦50 stamp duty above ₦10,000 — PRD §7.3', () => {
    const f = computePayoutFees(25_000 * NAIRA);
    expect(f.stampDutyKobo).toBe(STAMP_DUTY_KOBO);
    expect(f.netSentKobo).toBe(2_500_000 - 15_000); // rep charged ₦150 in total
  });

  it('switches on strictly above ₦10,000, not at it', () => {
    expect(computePayoutFees(10_000 * NAIRA).stampDutyKobo).toBe(0);
    expect(computePayoutFees(10_000 * NAIRA + 1).stampDutyKobo).toBe(STAMP_DUTY_KOBO);
  });

  it('always reconciles: the fees and the net sum back to the gross debit', () => {
    for (const amount of [MIN_PAYOUT_KOBO, 500_000, 1_000_000, 1_000_001, 2_500_000, 30_000_000]) {
      const f = computePayoutFees(amount);
      expect(f.netSentKobo + f.duevyFeeKobo + f.anchorFeeKobo + f.stampDutyKobo, `amount=${amount}`).toBe(
        amount,
      );
    }
  });

  it('leaves nothing to send once fees exceed the request', () => {
    // Guarded at the route by MIN_PAYOUT_KOBO, but the arithmetic must still be
    // honest rather than clamping to a positive transfer.
    expect(computePayoutFees(5_000).netSentKobo).toBeLessThanOrEqual(0);
  });
});

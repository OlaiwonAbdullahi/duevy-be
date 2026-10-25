import { describe, expect, it } from 'vitest';
import {
  allocate,
  checkoutFee,
  computeCharge,
  computeWithdrawal,
  decimalToKobo,
  discountedFee,
  koboToDecimal,
  krediPayoutCostKobo,
  withdrawalFee,
} from './money';

const NAIRA = 100;

describe('checkoutFee — 1.5% + ₦20, capped at ₦250, on top', () => {
  it('matches the published pricing table', () => {
    expect(checkoutFee(1_000 * NAIRA)).toBe(35 * NAIRA);
    expect(checkoutFee(3_000 * NAIRA)).toBe(65 * NAIRA);
    expect(checkoutFee(5_000 * NAIRA)).toBe(95 * NAIRA);
    expect(checkoutFee(10_000 * NAIRA)).toBe(170 * NAIRA);
    expect(checkoutFee(20_000 * NAIRA)).toBe(250 * NAIRA);
  });

  it('leaves the face amount whole and charges the student on top', () => {
    const c = computeCharge(5_000 * NAIRA);
    expect(c).toEqual({ face: 500_000, fee: 9_500, total: 509_500 });
  });

  it('caps the whole fee at ₦250 from about ₦15,334', () => {
    expect(checkoutFee(15_000 * NAIRA)).toBe(24_500);
    expect(checkoutFee(15_333 * NAIRA)).toBe(25_000); // 229.995 rounds up to exactly the cap
    expect(checkoutFee(15_334 * NAIRA)).toBe(25_000);
    expect(checkoutFee(1_000_000 * NAIRA)).toBe(25_000);
  });

  it('rounds the 1.5% half-up to the kobo', () => {
    expect(checkoutFee(100)).toBe(2 + 2_000); // 1.5 kobo → 2
    expect(checkoutFee(33)).toBe(0 + 2_000); // 0.495 kobo → 0
    expect(checkoutFee(34)).toBe(1 + 2_000); // 0.51 kobo → 1
  });

  it('charges the ₦20 once per checkout, not once per due', () => {
    const dues = [300_000, 150_000, 50_000];
    const basket = dues.reduce((a, b) => a + b, 0);
    expect(checkoutFee(basket)).toBe(7_500 + 2_000);
    expect(checkoutFee(basket)).toBeLessThan(dues.reduce((a, d) => a + checkoutFee(d), 0));
  });

  it('is zero for an empty basket and rejects non-integer or negative kobo', () => {
    expect(checkoutFee(0)).toBe(0);
    expect(() => checkoutFee(100.5)).toThrow(RangeError);
    expect(() => checkoutFee(-1)).toThrow(RangeError);
  });
});

describe('withdrawalFee — ₦50 under ₦10,000, ₦120 to ₦50,000, ₦200 above', () => {
  it('charges ₦50 below ₦10,000', () => {
    expect(withdrawalFee(1_000 * NAIRA)).toBe(5_000);
    expect(withdrawalFee(1_000_000 - 1)).toBe(5_000); // ₦9,999.99
  });

  it('charges ₦120 from ₦10,000 up to and including ₦50,000', () => {
    expect(withdrawalFee(10_000 * NAIRA)).toBe(12_000);
    expect(withdrawalFee(50_000 * NAIRA)).toBe(12_000);
  });

  it('charges ₦200 above ₦50,000', () => {
    expect(withdrawalFee(50_000 * NAIRA + 1)).toBe(20_000);
    expect(withdrawalFee(1_000_000 * NAIRA)).toBe(20_000);
  });

  it('deducts the fee from the withdrawal', () => {
    expect(computeWithdrawal(20_000 * NAIRA)).toEqual({ gross: 2_000_000, fee: 12_000, feeBeforeDiscount: 12_000, discount: 0, net: 1_988_000 });
    expect(computeWithdrawal(60_000 * NAIRA)).toEqual({ gross: 6_000_000, fee: 20_000, feeBeforeDiscount: 20_000, discount: 0, net: 5_980_000 });
  });

  it('applies a partner discount to the fee only', () => {
    expect(computeWithdrawal(20_000 * NAIRA, 50)).toEqual({ gross: 2_000_000, fee: 6_000, feeBeforeDiscount: 12_000, discount: 6_000, net: 1_994_000 });
    expect(computeWithdrawal(60_000 * NAIRA, 100)).toEqual({ gross: 6_000_000, fee: 0, feeBeforeDiscount: 20_000, discount: 20_000, net: 6_000_000 });
  });

  it('rounds the discount half-up and rejects bad percentages', () => {
    expect(discountedFee(10_000, 33)).toBe(6_700);
    expect(discountedFee(10_001, 50)).toBe(5_000); // 5000.5 off → 5001 off
    expect(() => discountedFee(10_000, 101)).toThrow(RangeError);
    expect(() => discountedFee(10_000, 12.5)).toThrow(RangeError);
  });

  it('always earns a margin over what Kredi charges for the transfer', () => {
    for (const gross of [1_000, 4_999, 5_000, 9_999, 10_000, 50_000, 50_001, 500_000].map((n) => n * NAIRA)) {
      const { fee, net } = computeWithdrawal(gross);
      expect(fee).toBeGreaterThan(krediPayoutCostKobo(net));
    }
  });
});

describe('allocate', () => {
  it('splits a fee across dues and always sums back exactly', () => {
    const parts = allocate(12_001, [300_000, 150_000, 50_000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(12_001);
    expect(parts).toEqual([7_201, 3_600, 1_200]);
  });

  it('handles a single due and huge values without precision loss', () => {
    expect(allocate(2_000, [1])).toEqual([2_000]);
    const big = allocate(9_000_000_000_000, [3_000_000_000_000, 1]);
    expect(big.reduce((a, b) => a + b, 0)).toBe(9_000_000_000_000);
  });
});

describe('decimal boundary', () => {
  it('formats kobo as the decimal string Kredi expects', () => {
    expect(koboToDecimal(700_000)).toBe('7000.00');
    expect(koboToDecimal(5)).toBe('0.05');
    expect(koboToDecimal(0)).toBe('0.00');
  });

  it('parses decimal strings and bare numbers into kobo without floats drifting', () => {
    expect(decimalToKobo('7000.00')).toBe(700_000);
    expect(decimalToKobo('7000')).toBe(700_000);
    expect(decimalToKobo('0.1')).toBe(10);
    expect(decimalToKobo('1.005')).toBe(101); // half-up at the third place
    expect(decimalToKobo(151250)).toBe(15_125_000);
    expect(decimalToKobo(0.29)).toBe(29);
  });

  it('rejects anything that is not a non-negative decimal', () => {
    for (const bad of ['', 'abc', '-1.00', '1e5', '1,000.00']) {
      expect(() => decimalToKobo(bad)).toThrow(RangeError);
    }
  });

  it('round-trips', () => {
    for (const k of [0, 1, 99, 100, 123_456_789]) expect(decimalToKobo(koboToDecimal(k))).toBe(k);
  });
});

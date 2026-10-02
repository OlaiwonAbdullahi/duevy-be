import { describe, expect, it } from 'vitest';
import {
  allocate,
  checkoutFee,
  computeCharge,
  computeWithdrawal,
  decimalToKobo,
  koboToDecimal,
  withdrawalFee,
  WITHDRAWAL_FEE_THRESHOLD_KOBO,
} from './money';

const NAIRA = 100;

describe('checkoutFee — 2% + ₦20, on top', () => {
  it('charges 2% plus ₦20 and leaves the face amount whole', () => {
    const c = computeCharge(5_000 * NAIRA);
    expect(c.face).toBe(500_000);
    expect(c.fee).toBe(10_000 + 2_000); // ₦100 + ₦20
    expect(c.total).toBe(512_000); // student pays ₦5,120, space receives ₦5,000
  });

  it('rounds the 2% half-up to the kobo', () => {
    expect(checkoutFee(25)).toBe(1 + 2_000); // 0.5 kobo → 1
    expect(checkoutFee(24)).toBe(0 + 2_000); // 0.48 kobo → 0
    expect(checkoutFee(12_345)).toBe(247 + 2_000); // 246.9 → 247
  });

  it('charges the ₦20 once per checkout, not once per due', () => {
    const dues = [300_000, 150_000, 50_000];
    const basket = dues.reduce((a, b) => a + b, 0);
    expect(checkoutFee(basket)).toBe(10_000 + 2_000);
    expect(checkoutFee(basket)).toBeLessThan(dues.reduce((a, d) => a + checkoutFee(d), 0));
  });

  it('is zero for an empty basket and rejects non-integer or negative kobo', () => {
    expect(checkoutFee(0)).toBe(0);
    expect(() => checkoutFee(100.5)).toThrow(RangeError);
    expect(() => checkoutFee(-1)).toThrow(RangeError);
  });
});

describe('withdrawalFee — ₦100 under ₦50,000, ₦200 from ₦50,000', () => {
  it('uses the low fee just under the threshold', () => {
    expect(withdrawalFee(WITHDRAWAL_FEE_THRESHOLD_KOBO - 1)).toBe(10_000); // ₦49,999.99
  });

  it('uses the high fee at exactly ₦50,000 and above', () => {
    expect(withdrawalFee(WITHDRAWAL_FEE_THRESHOLD_KOBO)).toBe(20_000);
    expect(withdrawalFee(1_000_000 * NAIRA)).toBe(20_000);
  });

  it('deducts the fee from the withdrawal', () => {
    expect(computeWithdrawal(20_000 * NAIRA)).toEqual({ gross: 2_000_000, fee: 10_000, net: 1_990_000 });
    expect(computeWithdrawal(50_000 * NAIRA)).toEqual({ gross: 5_000_000, fee: 20_000, net: 4_980_000 });
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
  it('formats kobo as the decimal string Bachs expects', () => {
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

import { describe, expect, it } from 'vitest';
import {
  allocate,
  bank78CollectionFee,
  checkoutFee,
  computeCharge,
  computeWithdrawal,
  decimalToKobo,
  discountedFee,
  koboToDecimal,
  withdrawalFee,
} from './money';

const NAIRA = 100;

describe('checkoutFee — 1.5% + Bank78, on top', () => {
  it('charges 1.5% and leaves the face amount whole', () => {
    const c = computeCharge(5_000 * NAIRA);
    expect(c.face).toBe(500_000);
    expect(c.fee).toBe(7_500); // ₦75
    expect(c.total).toBe(507_500); // student pays ₦5,075, space receives ₦5,000
  });

  it('rounds the 1.5% half-up to the kobo', () => {
    expect(checkoutFee(100)).toBe(2); // 1.5 kobo → 2
    expect(checkoutFee(33)).toBe(0); // 0.495 kobo → 0
    expect(checkoutFee(12_345)).toBe(185); // 185.175 → 185
  });

  it('adds what Bank78 charges to collect (nothing until Bank78 publishes a rate)', () => {
    expect(bank78CollectionFee(500_000)).toBe(0);
    expect(checkoutFee(500_000)).toBe(7_500 + bank78CollectionFee(500_000));
  });

  it('is charged once per checkout on the whole basket', () => {
    const dues = [300_000, 150_000, 50_000];
    expect(checkoutFee(dues.reduce((a, b) => a + b, 0))).toBe(7_500);
  });

  it('is zero for an empty basket and rejects non-integer or negative kobo', () => {
    expect(checkoutFee(0)).toBe(0);
    expect(() => checkoutFee(100.5)).toThrow(RangeError);
    expect(() => checkoutFee(-1)).toThrow(RangeError);
  });
});

describe('withdrawalFee — no Duevy fee for now', () => {
  it('is zero at any amount', () => {
    expect(withdrawalFee(1_000 * NAIRA)).toBe(0);
    expect(withdrawalFee(1_000_000 * NAIRA)).toBe(0);
  });

  it('sends the whole withdrawal to the bank', () => {
    expect(computeWithdrawal(20_000 * NAIRA)).toEqual({ gross: 2_000_000, fee: 0, feeBeforeDiscount: 0, discount: 0, net: 2_000_000 });
    expect(computeWithdrawal(20_000 * NAIRA, 50)).toEqual({ gross: 2_000_000, fee: 0, feeBeforeDiscount: 0, discount: 0, net: 2_000_000 });
  });

  it('rounds a partner discount half-up and rejects bad percentages', () => {
    expect(discountedFee(10_000, 33)).toBe(6_700);
    expect(discountedFee(10_001, 50)).toBe(5_000); // 5000.5 off → 5001 off
    expect(() => discountedFee(10_000, 101)).toThrow(RangeError);
    expect(() => discountedFee(10_000, 12.5)).toThrow(RangeError);
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
  it('formats kobo as a two-decimal string', () => {
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

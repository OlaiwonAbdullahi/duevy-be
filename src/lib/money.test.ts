import { describe, expect, it } from 'vitest';
import {
  allocate,
  checkoutFee,
  computeCharge,
  computeWithdrawal,
  decimalToKobo,
  koboToDecimal,
  splitWithdrawalFee,
  transferFee,
  withdrawalFee,
} from './money';

const NAIRA = 100;

describe('checkoutFee — 1.5%, on top', () => {
  it('charges 1.5% and leaves the face amount whole', () => {
    const c = computeCharge(5_000 * NAIRA);
    expect(c.face).toBe(500_000);
    expect(c.fee).toBe(7_500); // ₦75
    expect(c.total).toBe(507_500); // student pays ₦5,075, space receives ₦5,000
  });

  it('rounds up to the kobo', () => {
    expect(checkoutFee(1 * NAIRA)).toBe(2); // 1.5 kobo → 2
    expect(checkoutFee(1)).toBe(1); // 0.015 kobo → 1
    expect(checkoutFee(12_345)).toBe(186); // 185.175 → 186
  });

  it('always covers 9jaPay on the student’s transfer (0.5% capped at ₦750, + ₦50 from ₦10,000)', () => {
    for (const face of [10_000 * NAIRA, 9_900 * NAIRA, 150_000 * NAIRA, 500_000 * NAIRA]) {
      const total = face + checkoutFee(face);
      const cost = Math.min(Math.ceil(total * 0.005), 75_000) + (total >= 10_000 * NAIRA ? 5_000 : 0);
      expect(checkoutFee(face)).toBeGreaterThanOrEqual(cost);
    }
    expect(checkoutFee(10_000 * NAIRA)).toBe(15_000); // ₦150 against ₦100.75
    expect(checkoutFee(500_000 * NAIRA)).toBe(750_000); // ₦7,500, uncapped
  });

  it('is zero for an empty basket and rejects non-integer or negative kobo', () => {
    expect(checkoutFee(0)).toBe(0);
    expect(() => checkoutFee(100.5)).toThrow(RangeError);
    expect(() => checkoutFee(-1)).toThrow(RangeError);
  });
});

describe('withdrawalFee — 9jaPay’s transfer charge + 7.5% VAT: ₦10.75 / ₦16.13 / ₦21.50', () => {
  it('bands by amount', () => {
    expect(transferFee(1 * NAIRA)).toBe(1_075);
    expect(transferFee(4_999_99)).toBe(1_075); // ₦4,999.99
    expect(transferFee(5_000 * NAIRA)).toBe(1_613);
    expect(transferFee(99_999_99)).toBe(1_613);
    expect(transferFee(100_000 * NAIRA)).toBe(2_150);
    expect(transferFee(10_000_000 * NAIRA)).toBe(2_150);
    expect(withdrawalFee(20_000 * NAIRA)).toBe(1_613);
  });

  it('deducts the fee from the withdrawal', () => {
    expect(computeWithdrawal(1_900 * NAIRA)).toEqual({ gross: 190_000, fee: 1_075, charge: 1_000, vat: 75, net: 188_925 });
    expect(computeWithdrawal(20_000 * NAIRA)).toEqual({ gross: 2_000_000, fee: 1_613, charge: 1_500, vat: 113, net: 1_998_387 });
    expect(computeWithdrawal(150_000 * NAIRA)).toEqual({ gross: 15_000_000, fee: 2_150, charge: 2_000, vat: 150, net: 14_997_850 });
  });

  it('splits a stored fee into charge and VAT; a pre-VAT fee is all charge', () => {
    expect(splitWithdrawalFee(1_075)).toEqual({ chargeKobo: 1_000, vatKobo: 75 });
    expect(splitWithdrawalFee(2_150)).toEqual({ chargeKobo: 2_000, vatKobo: 150 });
    expect(splitWithdrawalFee(1_000)).toEqual({ chargeKobo: 1_000, vatKobo: 0 });
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

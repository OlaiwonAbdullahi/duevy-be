import { describe, expect, it } from 'vitest';
import { TRANSFER_NARRATION_MAX, transferNarration } from './narration';

describe('transferNarration: "Duevy/<space code> sent you ₦<amount>"', () => {
  it('reads as asked: the code and amount, with the naira sign, no reference or space name', () => {
    expect(transferNarration({ spaceCode: 'CSC', amountKobo: 300_000 })).toBe('Duevy/CSC sent you ₦3000');
    expect(transferNarration({ spaceCode: 'CSC', amountKobo: 300_050 })).toBe('Duevy/CSC sent you ₦3000.50');
  });

  it('stays far within 9jaPay\'s 50 characters for any code and the largest withdrawal', () => {
    const n = transferNarration({ spaceCode: 'FETSAX', amountKobo: 50_000_000 });
    expect(n).toBe('Duevy/FETSAX sent you ₦500000');
    expect(Buffer.byteLength(n, 'utf8')).toBeLessThanOrEqual(TRANSFER_NARRATION_MAX); // even counted in bytes
  });

  it('a "/" or stray character in a code cannot break the format', () => {
    expect(transferNarration({ spaceCode: 'A/H', amountKobo: 100_000 })).toBe('Duevy/A-H sent you ₦1000');
    expect(transferNarration({ spaceCode: 'ỌYC', amountKobo: 100_000 })).toBe('Duevy/OYC sent you ₦1000');
  });
});

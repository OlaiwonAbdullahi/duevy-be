import { describe, expect, it } from 'vitest';
import { startOfLagosDay } from './sweep.service';

describe('startOfLagosDay — the ₦10M daily limit resets at midnight in Lagos (UTC+1)', () => {
  it('is 23:00 UTC the previous evening', () => {
    expect(startOfLagosDay(new Date('2026-11-06T10:00:00Z')).toISOString()).toBe('2026-11-05T23:00:00.000Z');
  });

  it('rolls over at 23:00 UTC, not at UTC midnight', () => {
    expect(startOfLagosDay(new Date('2026-11-06T22:59:59Z')).toISOString()).toBe('2026-11-05T23:00:00.000Z');
    expect(startOfLagosDay(new Date('2026-11-06T23:00:00Z')).toISOString()).toBe('2026-11-06T23:00:00.000Z');
  });
});

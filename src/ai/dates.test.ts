import { describe, it, expect } from 'vitest';
import { resolve, resolveDueDate } from './dates';

/**
 * The deterministic date layer is resolved against a FIXED "now" so every
 * expectation is an exact, independently-calculated calendar date — never a
 * value the model (or a test) memorised.
 *
 * Anchor: 2026-11-14 is a Saturday, Africa/Lagos. This is the regression anchor
 * from the engineering brief: "same day next week" must be 2026-11-21, and the
 * agent must never ask for YYYY-MM-DD for any of these.
 */
const now = new Date('2026-11-14T12:00:00Z');
const tz = 'Africa/Lagos';
const r = (s: string) => resolve(s, { now, tz }).iso;

describe('resolve() — relative day/week expressions', () => {
  it('passes a real ISO date through unchanged', () => {
    expect(r('2026-12-15')).toBe('2026-12-15');
    expect(resolve('2026-13-40', { now, tz }).iso).toBeNull(); // not a real date
  });

  it('resolves the single-day anchors', () => {
    expect(r('today')).toBe('2026-11-14');
    expect(r('tomorrow')).toBe('2026-11-15');
    expect(r('day after tomorrow')).toBe('2026-11-16');
  });

  it('resolves "in N" and "N from now" with digits AND spelled-out numbers', () => {
    expect(r('in 3 days')).toBe('2026-11-17');
    expect(r('in three days')).toBe('2026-11-17');
    expect(r('in two weeks')).toBe('2026-11-28');
    expect(r('seven days from now')).toBe('2026-11-21');
    expect(r('a week from today')).toBe('2026-11-21');
  });

  it('resolves "in 48 hours" to +2 days (dues are date-only)', () => {
    expect(r('in 48 hours')).toBe('2026-11-16');
    expect(r('in 24 hours')).toBe('2026-11-15');
  });
});

describe('resolve() — the engineering-brief regression (anchor 2026-11-14, Africa/Lagos)', () => {
  // Each expression is calculated independently; they are NOT all the same date.
  const cases: Array<[string, string]> = [
    ['same day next week', '2026-11-21'],
    ['next week', '2026-11-21'],
    ['a week from today', '2026-11-21'],
    ['seven days from now', '2026-11-21'],
    ['by next Saturday', '2026-11-21'], // Sat→Sat is +7
    ['move it to next Friday', '2026-11-20'],
    ['this Friday', '2026-11-20'],
  ];
  it.each(cases)('%s → %s', (phrase, expected) => {
    expect(resolve(phrase, { now, tz }).iso).toBe(expected);
    // and it must be resolvable, never a clarification request
    expect(resolve(phrase, { now, tz }).confidence).not.toBe('low');
  });
});

describe('resolve() — month and week boundaries', () => {
  it('resolves end-of-month variants to the last day', () => {
    expect(r('end of the month')).toBe('2026-11-30');
    expect(r('month end')).toBe('2026-11-30');
    expect(r('by month end')).toBe('2026-11-30');
  });
  it('resolves beginning-of-next-month to the 1st', () => {
    expect(r('beginning of next month')).toBe('2026-12-01');
    expect(r('first of next month')).toBe('2026-12-01');
  });
  it('resolves "next month" to the same civil day next month (not +30)', () => {
    expect(r('next month')).toBe('2026-12-14');
  });
  it('clamps month arithmetic at month end', () => {
    // Jan 31 + 1 month → Feb 28 (2027 is not a leap year)
    expect(resolve('next month', { now: new Date('2027-01-31T12:00:00Z'), tz }).iso).toBe('2027-02-28');
  });
});

describe('resolve() — weekday names', () => {
  it('resolves a bare weekday to the next upcoming occurrence', () => {
    const res = resolve('friday', { now, tz });
    expect(new Date(`${res.iso}T00:00:00Z`).getUTCDay()).toBe(5);
    expect(res.iso! > '2026-11-14').toBe(true);
  });
  it('treats "next <weekday>" as the coming occurrence (documented Nigerian usage)', () => {
    expect(r('next friday')).toBe('2026-11-20');
  });
});

describe('resolve() — things we deliberately do NOT guess', () => {
  it('asks for clarification on academic periods instead of guessing', () => {
    const res = resolve('next semester', { now, tz });
    expect(res.iso).toBeNull();
    expect(res.confidence).toBe('low');
    expect(res.reason).toMatch(/semester|session|term/i);
  });
  it('returns low confidence with a reason for unparseable input', () => {
    expect(resolve('blah blah', { now, tz }).iso).toBeNull();
    expect(resolve('', { now, tz }).confidence).toBe('low');
    expect(resolve(undefined, { now, tz }).iso).toBeNull();
  });
});

describe('resolveDueDate() back-compat wrapper', () => {
  it('returns the ISO string or null', () => {
    expect(resolveDueDate('next week', { now, tz })).toBe('2026-11-21');
    expect(resolveDueDate('blah', { now, tz })).toBeNull();
  });
});

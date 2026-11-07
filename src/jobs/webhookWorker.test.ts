import { describe, expect, it } from 'vitest';
import { forEachLimit } from './webhookWorker';

describe('forEachLimit', () => {
  it('handles every item once and never exceeds the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachLimit([...Array(23).keys()], 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1 + (n % 3)));
      seen.push(n);
      inFlight -= 1;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(23).keys()]);
  });

  it('copes with fewer items than lanes, and none', async () => {
    const seen: number[] = [];
    await forEachLimit([1, 2], 10, async (n) => void seen.push(n));
    await forEachLimit([], 10, async () => void seen.push(-1));
    expect(seen.sort()).toEqual([1, 2]);
  });
});

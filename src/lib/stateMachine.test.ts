import { describe, expect, it } from 'vitest';
import {
  assertCheckoutTransition,
  assertPayoutTransition,
  canTransitionCheckout,
  canTransitionPayout,
  IllegalTransitionError,
} from './stateMachine';

describe('checkout transitions', () => {
  it('allows pending → paid | expired | underpaid', () => {
    for (const to of ['paid', 'expired', 'underpaid'] as const) expect(canTransitionCheckout('pending', to)).toBe(true);
  });

  it('honours late money (expired → paid) but never un-pays', () => {
    expect(canTransitionCheckout('expired', 'paid')).toBe(true);
    expect(canTransitionCheckout('paid', 'pending')).toBe(false);
    expect(canTransitionCheckout('paid', 'expired')).toBe(false);
    expect(canTransitionCheckout('expired', 'underpaid')).toBe(false);
    expect(() => assertCheckoutTransition('paid', 'expired')).toThrow(IllegalTransitionError);
  });
});

describe('payout transitions', () => {
  it('follows pending → processing → success | failed | reversed', () => {
    expect(canTransitionPayout('pending', 'processing')).toBe(true);
    for (const to of ['success', 'failed', 'reversed'] as const) expect(canTransitionPayout('processing', to)).toBe(true);
  });

  it('lets a provider refusal fail a pending payout, and a bank reverse a success', () => {
    expect(canTransitionPayout('pending', 'failed')).toBe(true);
    expect(canTransitionPayout('success', 'reversed')).toBe(true);
  });

  it('treats failed and reversed as terminal', () => {
    for (const to of ['pending', 'processing', 'success', 'reversed'] as const) {
      expect(canTransitionPayout('failed', to)).toBe(false);
    }
    expect(canTransitionPayout('reversed', 'success')).toBe(false);
    expect(canTransitionPayout('pending', 'success')).toBe(false);
    expect(() => assertPayoutTransition('failed', 'success')).toThrow(IllegalTransitionError);
  });
});

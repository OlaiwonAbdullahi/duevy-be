import { type CheckoutStatus, type PayoutStatus } from '@prisma/client';

/**
 * Legal status transitions for the two money objects. Every status write on a
 * Checkout or Payout goes through `assertTransition` (or `canTransition` when
 * the caller wants to no-op instead of throw), so an out-of-order or replayed
 * webhook can never walk a record backwards.
 */

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

type Graph<S extends string> = Record<S, readonly S[]>;

/**
 * pending → paid | expired | underpaid.
 * expired → paid is the one exception: money that arrives after the window
 * closed has still left the student's bank, so it is honoured, never dropped.
 * underpaid → paid covers a provider later accepting the partial payment.
 */
export const CHECKOUT_TRANSITIONS: Graph<CheckoutStatus> = {
  pending: ['paid', 'expired', 'underpaid'],
  expired: ['paid'],
  underpaid: ['paid'],
  paid: [],
};

/**
 * pending → processing → success | failed | reversed.
 * pending → failed: the provider rejected the payout at creation.
 * success → reversed: the bank returned the money after reporting success.
 */
export const PAYOUT_TRANSITIONS: Graph<PayoutStatus> = {
  pending: ['processing', 'failed'],
  processing: ['success', 'failed', 'reversed'],
  success: ['reversed'],
  failed: [],
  reversed: [],
};

function can<S extends string>(graph: Graph<S>, from: S, to: S): boolean {
  return graph[from]?.includes(to) ?? false;
}

export function canTransitionCheckout(from: CheckoutStatus, to: CheckoutStatus): boolean {
  return can(CHECKOUT_TRANSITIONS, from, to);
}

export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return can(PAYOUT_TRANSITIONS, from, to);
}

export function assertCheckoutTransition(from: CheckoutStatus, to: CheckoutStatus): void {
  if (!canTransitionCheckout(from, to)) throw new IllegalTransitionError('checkout', from, to);
}

export function assertPayoutTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransitionPayout(from, to)) throw new IllegalTransitionError('payout', from, to);
}

/** Statuses in which a payout's funds are still debited from the space. */
export const PAYOUT_ACTIVE: readonly PayoutStatus[] = ['pending', 'processing'];

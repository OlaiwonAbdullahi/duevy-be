/**
 * The payment-rail boundary. Everything Duevy needs from a provider goes
 * through this interface, in kobo and in our own vocabulary, so the rail can be
 * swapped without touching services or routes. Provider wire formats
 * (decimal strings, uppercase statuses, event envelopes) never leak past an
 * implementation.
 *
 * Keep it thin: one method per thing the business does, no provider concepts.
 */

export interface WalletProfile {
  /** Our user id — Bank78's sub-account userId, so a retry finds the same wallet. */
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** Pass-through only: never stored, never logged. */
  nin?: string;
  /** Bank78 requires it to open a sub-account. Pass-through only. */
  bvn: string;
}

/** A rep's wallet: the provider account collections are routed to and withdrawals paid from. */
export interface Wallet {
  accountNumber: string;
  bankName: string;
  active: boolean;
  /** Null when the provider did not report it. */
  availableKobo: number | null;
}

export interface CreateCollectionInput {
  /** Our checkout reference; also sent to the provider so events echo it back. */
  reference: string;
  /** The face amount — what the space (rep's account) receives. */
  faceKobo: number;
  /** Duevy's fee, charged on top. The student pays faceKobo + platformFeeKobo. */
  platformFeeKobo: number;
  customer: { email: string; name: string };
  expiresInMinutes: number;
  metadata: Record<string, string>;
}

/** How the student pays: a one-time bank account opened for this checkout. */
export interface CollectionAccount {
  providerCheckoutId: string;
  providerChargeId: string | null;
  accountNumber: string;
  bankName: string;
  accountName: string;
  /** What the provider will expect the student to send. */
  totalKobo: number;
  expiresAt: Date;
}

export type CollectionState = 'open' | 'paid' | 'expired' | 'failed' | 'underpaid';

export interface CollectionStatus {
  state: CollectionState;
  receivedKobo: number | null;
}

export interface ResolvedAccount {
  accountName: string;
}

export interface Bank {
  code: string;
  name: string;
}

export interface RegisterDestinationInput {
  accountId: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface PayoutDestination {
  destinationId: string;
  /** Whether it can receive money yet (it may sit in review). */
  usable: boolean;
  /** The name the bank holds for the account. */
  accountName: string | null;
}

export interface InitiatePayoutInput {
  /** The rep's wallet the payout is drawn from. */
  accountId: string;
  destinationId: string;
  /** What lands in the bank account. */
  amountKobo: number;
  /** Ours. Also the provider idempotency key, so a retry can never pay twice. */
  reference: string;
}

export type PayoutState = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface PayoutResult {
  providerPayoutId: string;
  state: PayoutState;
  /** What the provider charged on top, debited from the same wallet. */
  providerFeeKobo: number | null;
  failureReason: string | null;
}

export interface RouteCollectionInput {
  /** The rep's wallet the collection is credited to. */
  accountId: string;
  amountKobo: number;
  /** Ours. Also the provider idempotency key, so a retry can never credit twice. */
  reference: string;
}

// ---------------------------------------------------------------------------
// Normalised webhook events
// ---------------------------------------------------------------------------

interface EventBase {
  /** The provider's event id — the dedupe key. */
  eventId: string;
  /** The provider's raw event type, for logs and the admin view. */
  rawType: string;
  occurredAt: Date;
}

export type ProviderEvent =
  | (EventBase & {
      kind: 'payment.succeeded';
      reference: string | null;
      providerCheckoutId: string | null;
      providerChargeId: string | null;
      receivedKobo: number;
      /** Set when the provider reports more than the charge amount arrived. */
      overpaidKobo: number;
    })
  | (EventBase & {
      kind: 'payment.underpaid';
      reference: string | null;
      providerCheckoutId: string | null;
      providerChargeId: string | null;
      receivedKobo: number;
      expectedKobo: number;
    })
  | (EventBase & {
      kind: 'payment.expired';
      reference: string | null;
      providerCheckoutId: string | null;
    })
  | (EventBase & {
      kind: 'payment.failed';
      reference: string | null;
      providerCheckoutId: string | null;
      reason: string | null;
    })
  | (EventBase & {
      kind: 'payout.succeeded';
      reference: string | null;
      providerPayoutId: string | null;
      providerFeeKobo: number | null;
    })
  | (EventBase & {
      kind: 'payout.failed';
      reference: string | null;
      providerPayoutId: string | null;
      reason: string | null;
    })
  | (EventBase & { kind: 'ignored' });

export type ProviderEventKind = ProviderEvent['kind'];

export class InvalidSignatureError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

/** An authenticated webhook we could not make sense of. Stored as dead for a human. */
export class MalformedEventError extends Error {
  constructor(
    public readonly eventId: string | null,
    public readonly eventType: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'MalformedEventError';
  }
}

/**
 * A provider call failed. `code` is the provider's machine-readable error
 * code when it sent one; `retryable` is true for network errors, 429 and 5xx,
 * which must never be treated as "the operation did not happen".
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null,
    public readonly retryable: boolean,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface PaymentProvider {
  readonly name: string;

  // --- collections -----------------------------------------------------------
  /** Open a one-time bank account for one checkout. */
  createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount>;
  getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus>;
  /** Credit a paid checkout's face amount to the lead rep's wallet. */
  routeCollection(input: RouteCollectionInput): Promise<{ transferId: string | null }>;
  /** Verify the signature over the raw body and normalise the event. Throws InvalidSignatureError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;

  // --- rep wallets -------------------------------------------------------------
  /** Open (or find, on a retry) the rep's wallet. */
  createWallet(profile: WalletProfile): Promise<Wallet>;
  getWallet(accountId: string): Promise<Wallet>;

  // --- payouts -----------------------------------------------------------------
  listBanks(): Promise<Bank[]>;
  /** Name enquiry. Null when the bank cannot resolve the account. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null>;
  registerPayoutDestination(input: RegisterDestinationInput): Promise<PayoutDestination>;
  /** Send money from a rep's wallet to a registered bank account. */
  initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult>;
  getPayout(accountId: string, providerPayoutId: string): Promise<PayoutResult>;
}

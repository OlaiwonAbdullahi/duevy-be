/**
 * The payment-rail boundary. Everything Duevy needs from a provider goes
 * through this interface, in kobo and in our own vocabulary, so the rail can be
 * swapped without touching services or routes. Provider wire formats
 * (decimal amounts, status codes, webhook bodies) never leak past an
 * implementation.
 *
 * Money is pooled: collections settle into the platform's account, the
 * per-space ledger says whose it is, and payouts leave the platform account.
 *
 * Keep it thin: one method per thing the business does, no provider concepts.
 */

export type IdentityStatus = 'pending' | 'verified' | 'rejected';

export interface IdentityProfile {
  /** Our user id — echoed in provider metadata for support. */
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  phone?: string | null;
}

/** A government identifier. Pass-through only: never stored, never logged. */
export interface IdentityNumber {
  type: 'bvn';
  value: string;
}

/**
 * Open the rep's record at the provider. Called only after Duevy's own
 * checks (phone OTP and BVN match, via the identity verifier) have passed.
 */
export interface VerifyIdentityInput {
  profile: IdentityProfile;
  /** The BVN Duevy already matched to this rep. Pass-through only. */
  idNumbers: IdentityNumber[];
  /** Pass-through only. */
  gender: 'male' | 'female';
  /** Pass-through only. */
  address: string;
}

export interface IdentityResult {
  /** The rep's record at the provider (Kredi: the customer id). */
  accountId: string;
  /** The account number the provider gave the rep's record. */
  accountNumber: string | null;
  status: IdentityStatus;
  /** Whether the rep may withdraw right now. */
  payoutsActive: boolean;
  failureReason?: string | null;
}

export interface CreateCollectionInput {
  /** Our checkout reference; also sent to the provider so events echo it back. */
  reference: string;
  /** The face amount — what the space is credited. */
  faceKobo: number;
  /** Duevy's fee, charged on top. The student pays faceKobo + platformFeeKobo. */
  platformFeeKobo: number;
  customer: { email: string; name: string; phone?: string | null };
  expiresInMinutes: number;
  metadata: Record<string, string>;
  /** Where a hosted checkout sends the student back to, paid or not. */
  returnUrl: string;
}

/**
 * How the student pays: either a one-time bank account we show them, or a
 * provider-hosted page we redirect them to (`checkoutUrl`). Kredi: the account.
 */
export interface CollectionAccount {
  providerCheckoutId: string;
  providerChargeId: string | null;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
  checkoutUrl: string | null;
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
  /** The account holder's BVN, when the bank's name enquiry returns one. Never stored. */
  bvn?: string | null;
  kycLevel?: string | null;
}

export interface Bank {
  code: string;
  name: string;
}

/** A bank account money can be sent to. */
export interface BankDestination {
  bankCode: string;
  accountNumber: string;
  /** The name the bank returned at name enquiry. */
  accountName: string;
}

export interface InitiatePayoutInput {
  destination: BankDestination;
  /** What lands in the bank account. */
  amountKobo: number;
  /** Ours. Also the provider's transaction reference, so a retry can never pay twice. */
  reference: string;
}

export type PayoutState = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface PayoutResult {
  providerPayoutId: string;
  state: PayoutState;
  /** What the provider charged for the transfer (reporting only). */
  providerFeeKobo: number | null;
  failureReason: string | null;
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

  // --- the core operations -------------------------------------------------
  /** Open a payment for one checkout (a one-time account, or a hosted page). */
  createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount>;
  /** Open the rep's record at the provider, once Duevy has verified them. */
  verifyIdentity(input: VerifyIdentityInput): Promise<IdentityResult>;
  /** Name enquiry. Null when the bank cannot resolve the account. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null>;
  /** Send money from the platform account to a bank account. */
  initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult>;
  /** Verify the signature over the raw body and normalise the event. Throws InvalidSignatureError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;

  // --- supporting reads the core flows depend on ----------------------------
  listBanks(): Promise<Bank[]>;
  getIdentityStatus(accountId: string): Promise<IdentityResult>;
  getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus>;
  /** The payout's outcome, by our reference. */
  getPayout(reference: string): Promise<PayoutResult>;
  /** What the platform account actually holds — compared against the ledger. */
  getPlatformBalance(): Promise<{ availableKobo: number }>;
}

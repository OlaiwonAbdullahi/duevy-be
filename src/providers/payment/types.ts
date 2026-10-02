/**
 * The payment-rail boundary. Everything Duevy needs from a provider goes
 * through this interface, in kobo and in our own vocabulary, so the rail can be
 * swapped without touching services or routes. Provider wire formats
 * (decimal strings, uppercase statuses, event envelopes) never leak past an
 * implementation.
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

export interface VerifyIdentityInput {
  profile: IdentityProfile;
  /** Pass-through only. Never stored, never logged. */
  bvn: string;
  /** YYYY-MM-DD. Pass-through only. */
  dob: string;
  /** Re-use the rep's existing provider account/person on a retry. */
  existingAccountId?: string | null;
  existingPersonId?: string | null;
}

export interface IdentityResult {
  /** The rep's account at the provider — where collections settle. */
  accountId: string;
  /** The provider's reference for this verification (the person record). */
  personId: string;
  status: IdentityStatus;
  /** Whether the account may pay out right now. */
  payoutsActive: boolean;
  failureReason?: string | null;
}

export interface CreateCollectionInput {
  /** Our checkout reference; also sent to the provider so events echo it back. */
  reference: string;
  /** The face amount — what the space (rep's account) receives. */
  faceKobo: number;
  /** Duevy's fee, charged on top. The student pays faceKobo + platformFeeKobo. */
  platformFeeKobo: number;
  /** The rep's provider account the face amount is routed to. */
  destinationAccountId: string;
  customer: { email: string; name: string };
  expiresInMinutes: number;
  metadata: Record<string, string>;
}

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
  /** The rep's provider account the payout is drawn from. */
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
  /** What the provider charged on top, debited from the same account. */
  providerFeeKobo: number | null;
  failureReason: string | null;
}

export interface SettleFeeInput {
  /** The rep's provider account. */
  accountId: string;
  /** Positive: move from the rep's account to the platform. Negative: platform tops the account up. */
  amountKobo: number;
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
  | (EventBase & {
      kind: 'identity.updated';
      accountId: string;
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

  // --- the five core operations --------------------------------------------
  /** Open a one-time bank account for one checkout. */
  createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount>;
  /** Submit a rep's identity (BVN + DOB). The outcome arrives later by webhook. */
  verifyIdentity(input: VerifyIdentityInput): Promise<IdentityResult>;
  /** Name enquiry. Null when the bank cannot resolve the account. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null>;
  /** Send money from a rep's account to their registered bank account. */
  initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult>;
  /** Verify the signature over the raw body and normalise the event. Throws InvalidSignatureError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;

  // --- supporting reads/writes the core flows depend on ---------------------
  listBanks(): Promise<Bank[]>;
  getIdentityStatus(accountId: string, personId: string): Promise<IdentityResult>;
  registerPayoutDestination(input: RegisterDestinationInput): Promise<PayoutDestination>;
  getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus>;
  getPayout(accountId: string, providerPayoutId: string): Promise<PayoutResult>;
  /** Move Duevy's withdrawal fee (net of the provider's own payout fee) between the rep's account and the platform. */
  settleFee(input: SettleFeeInput): Promise<{ transferId: string }>;
}

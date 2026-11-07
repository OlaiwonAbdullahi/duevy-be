/**
 * The payment-rail boundary. Everything Duevy needs from a provider goes
 * through this interface, in kobo and in our own vocabulary, so the rail can be
 * swapped without touching services or routes. Provider wire formats
 * (decimal strings, uppercase statuses, event envelopes) never leak past an
 * implementation.
 *
 * Every account lives under Duevy's own business at the provider: one-time
 * accounts for checkouts, one permanent account per space, and the business
 * account they settle into. No rep holds an account, so no rep needs the
 * provider's KYC (rep identity is src/providers/identity).
 *
 * Keep it thin: one method per thing the business does, no provider concepts.
 */

export interface CreateCollectionInput {
  /** Our checkout reference; also sent to the provider so events echo it back. */
  reference: string;
  /** What the student must send: face + fee. Any other amount is refused. */
  totalKobo: number;
  expiresInMinutes: number;
}

/** The one-time bank account a student pays one checkout into. */
export interface CollectionAccount {
  /** The provider's reference for the checkout — what its events name. */
  providerCheckoutId: string;
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

export interface CreateSpaceAccountInput {
  /** Ours, unique per space; sent so a retry after a timeout can be detected. */
  reference: string;
  accountName: string;
}

/** A space's own permanent account, where its collections are swept. */
export interface SpaceAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankCode: string;
}

export interface ResolvedAccount {
  accountName: string;
}

export interface Bank {
  code: string;
  name: string;
}

export interface InitiateTransferInput {
  /** 'business' is Duevy's own account (a sweep); otherwise a space's account (a payout). */
  from: 'business' | { accountNumber: string; accountName: string };
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /** What lands in the recipient's account. */
  amountKobo: number;
  /** Ours. Also the provider's payment reference, so a retry can never pay twice. */
  reference: string;
  narration: string;
}

export type TransferState = 'processing' | 'succeeded' | 'failed';

export interface TransferResult {
  /** The reference the provider holds the transfer under, echoed in its events. */
  providerReference: string;
  state: TransferState;
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

/**
 * Events are cues, never proof: a provider event carries no timestamp and no
 * replay protection, so every handler confirms with the provider (collection
 * status, transfer status query) before moving money in our books.
 */
export type ProviderEvent =
  | (EventBase & {
      /** Money arrived in a checkout's one-time account. */
      kind: 'payment.received';
      providerCheckoutId: string;
    })
  | (EventBase & {
      /** Money arrived in a space's own account — a sweep landing. */
      kind: 'account.credited';
      accountNumber: string;
    })
  | (EventBase & {
      /** A transfer we started has a final status. */
      kind: 'transfer.updated';
      providerReference: string;
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

  /**
   * Our reference as the provider holds it (it may refuse some characters).
   * Deterministic, so it can be stored before the call that uses it and
   * events can be matched even when that call timed out.
   */
  wireReference(reference: string): string;

  /** Open a one-time bank account for one checkout. */
  createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount>;
  /**
   * What has arrived in a checkout's one-time account, read from the
   * provider's own records. Only money that landed within `window` counts:
   * 9jaPay reuses one-time account numbers, so the same number carries other
   * checkouts' payments from before and after this one.
   */
  getCollectionStatus(accountNumber: string, window: { from: Date; to: Date }): Promise<CollectionStatus>;

  /** Open a space's own permanent account. Money stays in it until paid out. */
  createSpaceAccount(input: CreateSpaceAccountInput): Promise<SpaceAccount>;

  /** Name enquiry. Null when the bank cannot resolve the account. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null>;
  listBanks(): Promise<Bank[]>;

  /** Move money: a sweep (business → space account) or a payout (space account → bank). */
  initiateTransfer(input: InitiateTransferInput): Promise<TransferResult>;
  /** The transfer's status, by the reference it was started with. */
  getTransfer(reference: string): Promise<TransferResult>;

  /** Verify the signature over the raw body and normalise the event. Throws InvalidSignatureError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;
}

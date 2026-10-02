import { randomInt } from 'crypto';
import {
  InvalidSignatureError,
  ProviderError,
  type Bank,
  type CollectionAccount,
  type CollectionStatus,
  type CreateCollectionInput,
  type IdentityResult,
  type IdentityStatus,
  type InitiatePayoutInput,
  type PaymentProvider,
  type PayoutDestination,
  type PayoutResult,
  type ProviderEvent,
  type RegisterDestinationInput,
  type ResolvedAccount,
  type SettleFeeInput,
  type VerifyIdentityInput,
} from '../types';
import { normaliseBachsEvent } from '../bachs/events';
import { verifyBachsSignature } from '../bachs/signature';

/**
 * In-memory provider for local development, the seed and the test suite.
 * PAYMENT_PROVIDER=fake. Refused in production by env validation.
 *
 * Its API calls succeed instantly against in-memory state. Its WEBHOOKS use
 * the real Bachs wire format and signature scheme, so scripts/send-test-webhook.ts
 * and the tests exercise exactly the parsing path production uses.
 *
 * Test knobs are plain public fields; `calls` records every operation.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';

  /** What verifyIdentity reports. Real KYC resolves later, by webhook. */
  identityOutcome: IdentityStatus = 'pending';
  /** What getIdentityStatus reports, per account — set this, then send identity.updated. */
  identityByAccount = new Map<string, { status: IdentityStatus; payoutsActive: boolean }>();
  /** Account numbers name enquiry cannot resolve. */
  unresolvable = new Set<string>();
  resolvedName = 'ADA OBI';
  /** What Bachs charges on top of each payout. */
  payoutFeeKobo = 5_000;
  /** The next initiatePayout throws this, once. */
  failNextPayout: ProviderError | null = null;
  /** Artificial latency for concurrency tests. */
  payoutDelayMs = 0;
  /** Collection status overrides for reconciliation tests. */
  collectionStatus = new Map<string, CollectionStatus>();
  payoutStatus = new Map<string, PayoutResult>();

  calls: { op: string; args: unknown }[] = [];
  private seq = 0;

  constructor(
    private readonly webhookSecrets: string[] = ['whsec_fake'],
    private readonly toleranceSeconds = 300,
  ) {}

  private record(op: string, args: unknown): void {
    // Never retain secrets, even in a test double.
    const safe = JSON.parse(JSON.stringify(args ?? {}, (k, v) => (k === 'bvn' || k === 'dob' ? '[redacted]' : v)));
    this.calls.push({ op, args: safe });
  }

  reset(): void {
    this.identityOutcome = 'pending';
    this.identityByAccount.clear();
    this.unresolvable.clear();
    this.failNextPayout = null;
    this.payoutDelayMs = 0;
    this.collectionStatus.clear();
    this.payoutStatus.clear();
    this.calls = [];
  }

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    this.record('createCollectionAccount', input);
    return {
      providerCheckoutId: `chk_fake_${input.reference}`,
      providerChargeId: `ch_fake_${input.reference}`,
      accountNumber: `99${randomInt(10_000_000, 99_999_999)}`,
      bankName: 'Fake Bank',
      accountName: 'Duevy Checkout',
      totalKobo: input.faceKobo + input.platformFeeKobo,
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
    };
  }

  async getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus> {
    this.record('getCollectionStatus', { providerCheckoutId });
    return this.collectionStatus.get(providerCheckoutId) ?? { state: 'open', receivedKobo: null };
  }

  async verifyIdentity(input: VerifyIdentityInput): Promise<IdentityResult> {
    this.record('verifyIdentity', input);
    if (!/^\d{11}$/.test(input.bvn)) throw new ProviderError('Invalid BVN', 422, 'VALIDATION_ERROR', false);
    const accountId = input.existingAccountId ?? `acct_fake_${input.profile.userId}`;
    const personId = input.existingPersonId ?? `per_fake_${input.profile.userId}`;
    const verified = this.identityOutcome === 'verified';
    this.identityByAccount.set(accountId, { status: this.identityOutcome, payoutsActive: verified });
    return { accountId, personId, status: this.identityOutcome, payoutsActive: verified, failureReason: null };
  }

  async getIdentityStatus(accountId: string, personId: string): Promise<IdentityResult> {
    this.record('getIdentityStatus', { accountId, personId });
    const s = this.identityByAccount.get(accountId) ?? { status: 'pending' as const, payoutsActive: false };
    return {
      accountId,
      personId,
      status: s.status,
      payoutsActive: s.payoutsActive,
      failureReason: s.status === 'rejected' ? 'BVN details did not match' : null,
    };
  }

  async listBanks(): Promise<Bank[]> {
    return [
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '044', name: 'Access Bank' },
      { code: '057', name: 'Zenith Bank' },
      { code: '033', name: 'United Bank for Africa' },
      { code: '50515', name: 'Moniepoint MFB' },
      { code: '999992', name: 'OPay' },
    ];
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    this.record('resolveAccount', { bankCode });
    if (this.unresolvable.has(accountNumber)) return null;
    return { accountName: this.resolvedName };
  }

  async registerPayoutDestination(input: RegisterDestinationInput): Promise<PayoutDestination> {
    this.record('registerPayoutDestination', { accountId: input.accountId, bankCode: input.bankCode });
    return { destinationId: `pd_fake_${++this.seq}`, usable: true, accountName: input.accountName };
  }

  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult> {
    this.record('initiatePayout', input);
    if (this.payoutDelayMs) await new Promise((r) => setTimeout(r, this.payoutDelayMs));
    if (this.failNextPayout) {
      const err = this.failNextPayout;
      this.failNextPayout = null;
      throw err;
    }
    const result: PayoutResult = {
      providerPayoutId: `pay_fake_${input.reference}`,
      state: 'processing',
      providerFeeKobo: this.payoutFeeKobo,
      failureReason: null,
    };
    this.payoutStatus.set(result.providerPayoutId, result);
    return result;
  }

  async getPayout(accountId: string, providerPayoutId: string): Promise<PayoutResult> {
    this.record('getPayout', { accountId, providerPayoutId });
    const p = this.payoutStatus.get(providerPayoutId);
    if (!p) throw new ProviderError('Payout not found', 404, 'NOT_FOUND', false);
    return p;
  }

  async settleFee(input: SettleFeeInput): Promise<{ transferId: string }> {
    this.record('settleFee', input);
    return { transferId: `tr_fake_${input.reference}` };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyBachsSignature(rawBody, headers, this.webhookSecrets, this.toleranceSeconds);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('Webhook body is not JSON');
    }
    return normaliseBachsEvent(body);
  }
}

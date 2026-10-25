import {
  InvalidSignatureError,
  ProviderError,
  type Bank,
  type CollectionAccount,
  type CollectionStatus,
  type CreateCollectionInput,
  type IdentityResult,
  type InitiatePayoutInput,
  type PaymentProvider,
  type PayoutResult,
  type ProviderEvent,
  type ResolvedAccount,
  type VerifyIdentityInput,
} from '../types';
import { normaliseKrediEvent } from '../kredi/events';
import { verifyKrediSignature } from '../kredi/signature';

/**
 * In-memory provider for local development, the seed and the test suite.
 * PAYMENT_PROVIDER=fake. Refused in production by env validation.
 *
 * Its API calls succeed instantly against in-memory state. Its WEBHOOKS use
 * the real Kredi wire format and signature scheme, so scripts/send-test-webhook.ts
 * and the tests exercise exactly the parsing path production uses.
 *
 * Test knobs are plain public fields; `calls` records every operation.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';

  /** The next verifyIdentity throws this, once (e.g. a 4xx refusal). */
  failNextIdentity: ProviderError | null = null;
  /** Account numbers name enquiry cannot resolve. */
  unresolvable = new Set<string>();
  resolvedName = 'ADA OBI';
  /** What Kredi charges for each payout (reporting only). */
  payoutFeeKobo = 2_500;
  /** The next initiatePayout throws this, once. */
  failNextPayout: ProviderError | null = null;
  /** Artificial latency for concurrency tests. */
  payoutDelayMs = 0;
  /** Collection status overrides for reconciliation tests. */
  collectionStatus = new Map<string, CollectionStatus>();
  /** Payout outcomes by our reference, as getPayout reports them. */
  payoutStatus = new Map<string, PayoutResult>();
  platformBalanceKobo = 0;

  calls: { op: string; args: unknown }[] = [];
  private seq = 0;

  constructor(private readonly webhookSecrets: string[] = ['whsec_fake']) {}

  private record(op: string, args: unknown): void {
    // Never retain secrets, even in a test double.
    const safe = JSON.parse(
      JSON.stringify(args ?? {}, (k, v) => (['bvn', 'dob', 'idNumbers', 'buffer'].includes(k) ? '[redacted]' : v)),
    );
    this.calls.push({ op, args: safe });
  }

  reset(): void {
    this.failNextIdentity = null;
    this.unresolvable.clear();
    this.resolvedName = 'ADA OBI';
    this.failNextPayout = null;
    this.payoutDelayMs = 0;
    this.collectionStatus.clear();
    this.payoutStatus.clear();
    this.platformBalanceKobo = 0;
    this.calls = [];
  }

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    this.record('createCollectionAccount', input);
    return {
      providerCheckoutId: `fake_${input.reference}`,
      providerChargeId: null,
      accountNumber: `08${String(++this.seq).padStart(8, '0')}`,
      bankName: null,
      accountName: 'Duevy Labs Ltd',
      checkoutUrl: null,
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
    if (this.failNextIdentity) {
      const err = this.failNextIdentity;
      this.failNextIdentity = null;
      throw err;
    }
    if (!input.idNumbers.some((n) => n.type === 'bvn' && /^\d{11}$/.test(n.value))) {
      throw new ProviderError('A valid BVN is required', 422, 'VALIDATION_ERROR', false);
    }
    return {
      accountId: `cus_fake_${input.profile.userId}`,
      accountNumber: `99${String(++this.seq).padStart(8, '0')}`,
      status: 'verified',
      payoutsActive: true,
      failureReason: null,
    };
  }

  async getIdentityStatus(accountId: string): Promise<IdentityResult> {
    this.record('getIdentityStatus', { accountId });
    return { accountId, accountNumber: null, status: 'verified', payoutsActive: true, failureReason: null };
  }

  async listBanks(): Promise<Bank[]> {
    return [
      { code: '000014', name: 'Access Bank' },
      { code: '000013', name: 'Guaranty Trust Bank' },
      { code: '090267', name: 'Kuda MFB' },
      { code: '090405', name: 'Moniepoint MFB' },
      { code: '100004', name: 'OPay' },
      { code: '000004', name: 'United Bank for Africa' },
      { code: '000015', name: 'Zenith Bank' },
      // Kept for fixtures written against the old 3-digit codes.
      { code: '058', name: 'Guaranty Trust Bank' },
    ];
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    this.record('resolveAccount', { bankCode });
    if (this.unresolvable.has(accountNumber)) return null;
    return { accountName: this.resolvedName, bvn: '22222222222', kycLevel: '3' };
  }

  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult> {
    this.record('initiatePayout', { ...input, destination: { ...input.destination, accountNumber: '[redacted]' } });
    if (this.payoutDelayMs) await new Promise((r) => setTimeout(r, this.payoutDelayMs));
    if (this.failNextPayout) {
      const err = this.failNextPayout;
      this.failNextPayout = null;
      throw err;
    }
    const result: PayoutResult = {
      providerPayoutId: `KRDM_fake_${input.reference}`,
      state: 'processing',
      providerFeeKobo: this.payoutFeeKobo,
      failureReason: null,
    };
    this.payoutStatus.set(input.reference, result);
    return result;
  }

  async getPayout(reference: string): Promise<PayoutResult> {
    this.record('getPayout', { reference });
    const p = this.payoutStatus.get(reference);
    if (!p) return { providerPayoutId: reference, state: 'pending', providerFeeKobo: null, failureReason: null };
    return p;
  }

  async getPlatformBalance(): Promise<{ availableKobo: number }> {
    return { availableKobo: this.platformBalanceKobo };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyKrediSignature(rawBody, headers, this.webhookSecrets);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    return normaliseKrediEvent(JSON.parse(rawBody.toString('utf8')));
  }
}

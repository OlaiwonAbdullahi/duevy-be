import { randomInt } from 'crypto';
import {
  InvalidSignatureError,
  ProviderError,
  type Bank,
  type CollectionAccount,
  type CollectionStatus,
  type CreateCollectionInput,
  type InitiatePayoutInput,
  type PaymentProvider,
  type PayoutDestination,
  type PayoutResult,
  type ProviderEvent,
  type RegisterDestinationInput,
  type ResolvedAccount,
  type RouteCollectionInput,
  type Wallet,
  type WalletProfile,
} from '../../providers/payment';
import { normaliseBank78Event } from '../../providers/payment/bank78/events';
import { verifyBank78Signature } from '../../providers/payment/bank78/signature';

/**
 * In-memory payment rail for the integration suite. Test-only: nothing in
 * src/ can select it; tests install it with setPaymentProvider.
 *
 * Its API calls succeed instantly against in-memory state. Its WEBHOOKS use
 * the real Bank78 wire format and signature scheme, so the tests exercise
 * exactly the parsing path production uses.
 *
 * Test knobs are plain public fields; `calls` records every operation.
 */
export class PaymentDouble implements PaymentProvider {
  readonly name = 'bank78';

  /** Account numbers name enquiry cannot resolve. */
  unresolvable = new Set<string>();
  resolvedName = 'ADA OBI';
  /** What Bank78 charges on top of each payout. */
  payoutFeeKobo = 5_000;
  /** The next initiatePayout throws this, once. */
  failNextPayout: ProviderError | null = null;
  /** The next routeCollection throws this, once. */
  failNextRoute: ProviderError | null = null;
  /** The next createWallet throws this, once. */
  failNextWallet: ProviderError | null = null;
  /** Artificial latency for concurrency tests. */
  payoutDelayMs = 0;
  /** Collection status overrides for reconciliation tests. */
  collectionStatus = new Map<string, CollectionStatus>();
  payoutStatus = new Map<string, PayoutResult>();
  wallets = new Map<string, Wallet>();

  calls: { op: string; args: unknown }[] = [];

  constructor(
    private readonly webhookSecrets: string[] = ['whsec_test_secret'],
    private readonly toleranceSeconds = 300,
  ) {}

  private record(op: string, args: unknown): void {
    // Never retain secrets, even in a test double.
    const safe = JSON.parse(JSON.stringify(args ?? {}, (k, v) => (['nin', 'bvn', 'dob'].includes(k) ? '[redacted]' : v)));
    this.calls.push({ op, args: safe });
  }

  reset(): void {
    this.unresolvable.clear();
    this.resolvedName = 'ADA OBI';
    this.payoutFeeKobo = 5_000;
    this.failNextPayout = null;
    this.failNextRoute = null;
    this.failNextWallet = null;
    this.payoutDelayMs = 0;
    this.collectionStatus.clear();
    this.payoutStatus.clear();
    this.wallets.clear();
    this.calls = [];
  }

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    this.record('createCollectionAccount', input);
    return {
      providerCheckoutId: input.reference,
      providerChargeId: null,
      accountNumber: `70${randomInt(10_000_000, 99_999_999)}`,
      bankName: 'Bank78',
      accountName: `Duevy ${input.customer.name}`,
      totalKobo: input.faceKobo + input.platformFeeKobo,
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
    };
  }

  async getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus> {
    this.record('getCollectionStatus', { providerCheckoutId });
    return this.collectionStatus.get(providerCheckoutId) ?? { state: 'open', receivedKobo: null };
  }

  async routeCollection(input: RouteCollectionInput): Promise<{ transferId: string | null }> {
    this.record('routeCollection', input);
    if (this.failNextRoute) {
      const err = this.failNextRoute;
      this.failNextRoute = null;
      throw err;
    }
    return { transferId: input.reference };
  }

  async createWallet(profile: WalletProfile): Promise<Wallet> {
    this.record('createWallet', profile);
    if (this.failNextWallet) {
      const err = this.failNextWallet;
      this.failNextWallet = null;
      throw err;
    }
    const existing = this.wallets.get(profile.userId);
    if (existing) return existing;
    const wallet: Wallet = { accountNumber: `00${randomInt(10_000_000, 99_999_999)}`, bankName: 'Bank78', active: true, availableKobo: 0 };
    this.wallets.set(profile.userId, wallet);
    return wallet;
  }

  async getWallet(accountId: string): Promise<Wallet> {
    this.record('getWallet', { accountId });
    return [...this.wallets.values()].find((w) => w.accountNumber === accountId) ?? { accountNumber: accountId, bankName: 'Bank78', active: true, availableKobo: 0 };
  }

  async listBanks(): Promise<Bank[]> {
    return [
      { code: '044', name: 'Access Bank' },
      { code: '110072', name: 'Bank78' },
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '50515', name: 'Moniepoint MFB' },
      { code: '999992', name: 'OPay' },
      { code: '033', name: 'United Bank for Africa' },
      { code: '057', name: 'Zenith Bank' },
    ];
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    this.record('resolveAccount', { bankCode });
    if (this.unresolvable.has(accountNumber)) return null;
    return { accountName: this.resolvedName };
  }

  async registerPayoutDestination(input: RegisterDestinationInput): Promise<PayoutDestination> {
    this.record('registerPayoutDestination', { accountId: input.accountId, bankCode: input.bankCode });
    return { destinationId: `dest_${input.bankCode}_${input.accountNumber.slice(-4)}_${input.accountId}`, usable: true, accountName: input.accountName };
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
      providerPayoutId: input.reference,
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
    if (!p) throw new ProviderError('Transfer not found!', 400, 'BANK78TF01020', false);
    return p;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyBank78Signature(rawBody, headers, this.webhookSecrets, this.toleranceSeconds);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('Webhook body is not JSON');
    }
    return normaliseBank78Event(body);
  }
}

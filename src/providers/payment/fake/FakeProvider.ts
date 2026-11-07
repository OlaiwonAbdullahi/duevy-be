import { randomInt, randomUUID } from 'crypto';
import {
  InvalidSignatureError,
  ProviderError,
  type Bank,
  type CollectionAccount,
  type CollectionStatus,
  type CreateCollectionInput,
  type CreateSpaceAccountInput,
  type InitiateTransferInput,
  type PaymentProvider,
  type ProviderEvent,
  type ResolvedAccount,
  type SpaceAccount,
  type TransferResult,
  type TransferState,
} from '../types';
import { normaliseNineJaPayEvent, SPACE_ACCOUNT_PREFIX } from '../ninejapay/events';
import { verifyNineJaPaySignature } from '../ninejapay/signature';

/**
 * In-memory provider for local development, the seed and the test suite.
 * PAYMENT_PROVIDER=fake. Refused in production by env validation.
 *
 * Its API calls succeed instantly against in-memory state. Its WEBHOOKS use
 * the real 9jaPay wire format and signature scheme, so
 * scripts/send-test-webhook.ts and the tests exercise exactly the parsing
 * path production uses.
 *
 * Test knobs are plain public fields; `calls` records every operation.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';

  /** Account numbers name enquiry cannot resolve. */
  unresolvable = new Set<string>();
  resolvedName = 'ADA OBI';
  /** What a new transfer reports: 9jaPay answers SUCCESS, PROCESSING or FAILED up front. */
  transferOutcome: TransferState = 'processing';
  /** The next initiateTransfer throws this, once. */
  failNextTransfer: ProviderError | null = null;
  /** Artificial latency for concurrency tests. */
  transferDelayMs = 0;
  /** What has arrived per one-time account number, for reconciliation tests. */
  collectionStatus = new Map<string, CollectionStatus>();
  /** Every transfer started, by our reference. Tests set `state` to settle one. */
  transfers = new Map<string, TransferResult & { input: InitiateTransferInput }>();

  calls: { op: string; args: unknown }[] = [];

  constructor(private readonly webhookSecrets: string[] = ['whsec_fake']) {}

  private record(op: string, args: unknown): void {
    this.calls.push({ op, args: JSON.parse(JSON.stringify(args ?? {})) });
  }

  reset(): void {
    this.unresolvable.clear();
    this.resolvedName = 'ADA OBI';
    this.transferOutcome = 'processing';
    this.failNextTransfer = null;
    this.transferDelayMs = 0;
    this.collectionStatus.clear();
    this.transfers.clear();
    this.calls = [];
  }

  wireReference(reference: string): string {
    return reference.replace(/[^A-Za-z0-9]/g, '');
  }

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    this.record('createCollectionAccount', input);
    return {
      providerCheckoutId: this.wireReference(input.reference),
      accountNumber: `90${randomInt(10_000_000, 99_999_999)}`,
      bankName: '9jaPay',
      accountName: 'Duevy Checkout',
      totalKobo: input.totalKobo,
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
    };
  }

  async getCollectionStatus(accountNumber: string, window: { from: Date; to: Date }): Promise<CollectionStatus> {
    this.record('getCollectionStatus', { accountNumber, window });
    return this.collectionStatus.get(accountNumber) ?? { state: 'open', receivedKobo: null };
  }

  async createSpaceAccount(input: CreateSpaceAccountInput): Promise<SpaceAccount> {
    this.record('createSpaceAccount', input);
    return {
      accountId: `va_fake_${randomUUID()}`,
      accountNumber: `91${randomInt(10_000_000, 99_999_999)}`,
      accountName: input.accountName,
      bankName: '9jaPay',
      bankCode: '090629',
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
      { code: '090629', name: 'AMEGY MFB (9jaPay)' },
    ];
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    this.record('resolveAccount', { bankCode });
    if (this.unresolvable.has(accountNumber)) return null;
    return { accountName: this.resolvedName };
  }

  async initiateTransfer(input: InitiateTransferInput): Promise<TransferResult> {
    this.record('initiateTransfer', input);
    if (this.transferDelayMs) await new Promise((r) => setTimeout(r, this.transferDelayMs));
    if (this.failNextTransfer) {
      const err = this.failNextTransfer;
      this.failNextTransfer = null;
      throw err;
    }
    // Same reference again: like 9jaPay's duplicate check, report the original.
    const existing = this.transfers.get(input.reference);
    if (existing) return { providerReference: existing.providerReference, state: existing.state, failureReason: existing.failureReason };
    const result: TransferResult = {
      providerReference: this.wireReference(input.reference),
      state: this.transferOutcome,
      failureReason: this.transferOutcome === 'failed' ? 'The bank could not complete the transfer' : null,
    };
    this.transfers.set(input.reference, { ...result, input });
    return result;
  }

  async getTransfer(reference: string): Promise<TransferResult> {
    this.record('getTransfer', { reference });
    const t = this.transfers.get(reference);
    if (!t) throw new ProviderError('No record found.', 404, 'NOT_FOUND', false);
    return { providerReference: t.providerReference, state: t.state, failureReason: t.failureReason };
  }

  /** Test helper: settle a started transfer. */
  settleTransfer(reference: string, state: TransferState): void {
    const t = this.transfers.get(reference);
    if (!t) throw new Error(`no fake transfer ${reference}`);
    t.state = state;
    t.failureReason = state === 'failed' ? 'The bank could not complete the transfer' : null;
  }

  /** The request reference a space account is created with, for webhook tests. */
  static spaceAccountReference(spaceId: string): string {
    return `${SPACE_ACCOUNT_PREFIX}${spaceId.replace(/[^A-Za-z0-9]/g, '')}`;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyNineJaPaySignature(rawBody, headers, this.webhookSecrets);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('Webhook body is not JSON');
    }
    return normaliseNineJaPayEvent(body);
  }
}

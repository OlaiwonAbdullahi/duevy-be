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
import { NineJaPayClient } from './client';
import { normaliseNineJaPayEvent, SPACE_ACCOUNT_PREFIX } from './events';
import { verifyNineJaPaySignature } from './signature';

/**
 * 9jaPay as Duevy's payment rail (see docs/NINEJAPAY.md for the full picture).
 *
 *  - Every checkout gets a one-time (transient) account for exactly its
 *    total, single payment only. What is paid into it settles straight into
 *    Duevy's business account.
 *  - Every space has its own permanent account, autoPayout off, so money
 *    swept into it stays there until the space withdraws it.
 *  - Sweeps are transfers from the business account; withdrawals are
 *    transfers from the space's account. Both need a fresh name enquiry,
 *    whose reference is single-use.
 *
 * References: 9jaPay accepts letters and digits only, so ours are sent with
 * everything else stripped (wireReference). Our formats keep that unique.
 */

const BANK_NAME = '9jaPay';

export interface NineJaPayConfig {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
  /** Duevy's own business account: where collections settle and sweeps start. */
  businessAccountNumber: string;
  /** 9jaPay's own bank code, for transfers into a space's account. */
  bankCode: string;
}

interface CreatedAccount {
  requestReference?: string;
  id: string;
  accountNumber: string;
}
interface AccountDetails {
  accountNumber: string;
  accountName?: string;
  status?: string;
  expiresAt?: string;
}
interface Transaction {
  transactionId: string;
  accountNumber?: string;
  transactionType?: string;
  amount?: number | string;
  transactionDate?: string;
  notificationStatus?: string;
}

/**
 * 9jaPay's transactionDate is Lagos wall-clock time with no offset
 * ("2026-11-07T08:35:38.005074" while expiresAt is "…07:05:36Z"-style UTC).
 * Read it as UTC+1 unless it carries its own offset.
 */
export function parseNineJaPayDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const ms = Date.parse(hasOffset ? raw : `${raw.replace(/(\.\d{3})\d+$/, '$1')}+01:00`);
  return Number.isNaN(ms) ? null : new Date(ms);
}
interface NameEnquiry {
  accountName: string;
  accountNumber: string;
  bankCode: string;
  nameEnquiryReference: string;
}
interface Transfer {
  id?: string;
  paymentReference?: string;
  status?: string;
}

function mapTransferStatus(raw: string | undefined, statusCode?: string): TransferState {
  switch ((raw ?? '').toLowerCase()) {
    case 'success':
    case 'successful':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return statusCode === '00' ? 'succeeded' : 'processing';
  }
}

export class NineJaPayProvider implements PaymentProvider {
  readonly name = 'ninejapay';
  private readonly client: NineJaPayClient;
  /** The business account's name as the bank holds it, looked up once. */
  private businessAccountName: Promise<string> | null = null;

  constructor(
    private readonly config: NineJaPayConfig,
    private readonly webhookSecrets: string[],
  ) {
    this.client = new NineJaPayClient(config.baseUrl, config.apiKey, config.secretKey);
  }

  wireReference(reference: string): string {
    return reference.replace(/[^A-Za-z0-9]/g, '');
  }

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    const reference = this.wireReference(input.reference);
    const res = await this.client.request<CreatedAccount>({
      method: 'POST',
      path: '/v1/api/virtual-accounts/transient',
      op: 'collection.create',
      ref: input.reference,
      body: {
        requestReference: reference,
        // Exactly this amount, or the transfer is refused at the bank.
        amount: input.totalKobo,
        timeToLive: String(input.expiresInMinutes * 60),
        IsSinglePayment: true,
      },
    });
    const created = res.data;
    if (!created?.accountNumber) throw new ProviderError('9jaPay returned no account number', null, null, false);
    const details = await this.getAccount(created.accountNumber, input.reference).catch(() => null);
    return {
      providerCheckoutId: reference,
      accountNumber: created.accountNumber,
      bankName: BANK_NAME,
      // "DUEVY COLLECTION ACCOUNT" in the sandbox: 9jaPay names these, not us.
      accountName: details?.accountName ?? 'Duevy',
      totalKobo: input.totalKobo,
      expiresAt:
        details?.expiresAt && !Number.isNaN(Date.parse(details.expiresAt))
          ? new Date(details.expiresAt)
          : new Date(Date.now() + input.expiresInMinutes * 60_000),
    };
  }

  /**
   * What has been paid into a one-time account, from 9jaPay's transaction
   * list. Any credit inside the window counts as paid with that amount: the
   * checkout service decides whether it covers the total. The window matters:
   * 9jaPay hands the same account number to a later checkout once this one
   * closes (seen in the sandbox, 2026-11-07), so its list holds other
   * students' payments too. The closing "VIRTUAL ACCOUNT CLOSURE TRANSFER"
   * debit (the money moving to the collection account) is ignored.
   */
  async getCollectionStatus(accountNumber: string, window: { from: Date; to: Date }): Promise<CollectionStatus> {
    const res = await this.client.request<Transaction[]>({
      method: 'GET',
      path: '/v1/api/transactions',
      op: 'collection.transactions',
      query: { 'page-size': '50', 'page-number': '1', 'account-number': accountNumber },
    });
    const credits = (res.data ?? []).filter((t) => {
      if ((t.transactionType ?? '').toLowerCase() !== 'credit' || (t.accountNumber ?? accountNumber) !== accountNumber) return false;
      const at = parseNineJaPayDate(t.transactionDate);
      return at !== null && at >= window.from && at <= window.to;
    });
    if (credits.length === 0) return { state: 'open', receivedKobo: null };
    const received = credits.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
    return { state: 'paid', receivedKobo: received };
  }

  async createSpaceAccount(input: CreateSpaceAccountInput): Promise<SpaceAccount> {
    const reference = `${SPACE_ACCOUNT_PREFIX}${this.wireReference(input.reference)}`;
    const res = await this.client.request<CreatedAccount>({
      method: 'POST',
      path: '/v1/api/virtual-accounts/permanent',
      op: 'space_account.create',
      ref: input.reference,
      body: { requestReference: reference, accountName: input.accountName, autoPayoutEnabled: false },
    });
    const created = res.data;
    if (!created?.accountNumber) throw new ProviderError('9jaPay returned no account number', null, null, false);
    // 9jaPay prefixes the business name ("DUEVY/<name>"); keep the name the
    // bank actually shows, which is also what a sweep's name check expects.
    const shown = await this.nameEnquiry(this.config.bankCode, created.accountNumber, input.reference).catch(() => null);
    return {
      accountId: created.id,
      accountNumber: created.accountNumber,
      accountName: shown?.accountName ?? input.accountName,
      bankName: BANK_NAME,
      bankCode: this.config.bankCode,
    };
  }

  private async getAccount(accountNumber: string, ref?: string): Promise<AccountDetails | null> {
    const res = await this.client.request<AccountDetails>({
      method: 'GET',
      path: `/v1/api/virtual-accounts/${encodeURIComponent(accountNumber)}`,
      op: 'account.get',
      ref,
    });
    return res.data ?? null;
  }

  async listBanks(): Promise<Bank[]> {
    const res = await this.client.request<{ name: string; code: string }[]>({ method: 'GET', path: '/v1/api/banks', op: 'banks.list' });
    return (res.data ?? []).map((b) => ({ code: b.code, name: b.name }));
  }

  private async nameEnquiry(bankCode: string, accountNumber: string, ref?: string): Promise<NameEnquiry | null> {
    try {
      const res = await this.client.request<NameEnquiry>({
        method: 'POST',
        path: '/v1/api/transfers/name-enquiry',
        op: 'name_enquiry',
        ref,
        body: { bankCode, accountNumber },
      });
      return res.data?.accountName ? res.data : null;
    } catch (err) {
      // The bank couldn't find the account, or the input was invalid: not an
      // outage, so it resolves to "unverifiable". 9jaPay reports an unknown
      // account as HTTP 500 / "06" "Unable to validate account number!"
      // (sandbox, 2026-11-06), so the 5xx alone doesn't mean it's down.
      if (err instanceof ProviderError && err.status !== null) {
        if (err.status < 500 || /validate|not found|invalid/i.test(err.message)) return null;
      }
      throw err;
    }
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    const found = await this.nameEnquiry(bankCode, accountNumber);
    return found ? { accountName: found.accountName } : null;
  }

  async initiateTransfer(input: InitiateTransferInput): Promise<TransferResult> {
    const reference = this.wireReference(input.reference);
    const enquiry = await this.nameEnquiry(input.bankCode, input.accountNumber, input.reference);
    if (!enquiry) throw new ProviderError('The recipient account could not be verified', 422, 'ACCOUNT_UNVERIFIABLE', false);

    const fromBusiness = input.from === 'business';
    const sender = input.from === 'business'
      ? { accountNumber: this.config.businessAccountNumber, accountName: await this.getBusinessAccountName() }
      : input.from;
    try {
      const res = await this.client.request<Transfer>({
        method: 'POST',
        path: fromBusiness ? '/v1/api/transfers' : '/v1/api/transfers/virtual-account',
        op: fromBusiness ? 'sweep.create' : 'payout.create',
        ref: input.reference,
        body: {
          paymentReference: reference,
          senderAccountNumber: sender.accountNumber,
          senderAccountName: sender.accountName,
          recipientAccountNumber: input.accountNumber,
          recipientAccountName: enquiry.accountName,
          recipientBankCode: input.bankCode,
          amount: String(input.amountKobo),
          nameEnquiryReference: enquiry.nameEnquiryReference,
          narration: input.narration.slice(0, 100),
        },
      });
      return { providerReference: reference, state: mapTransferStatus(res.status, res.statusCode), failureReason: null };
    } catch (err) {
      // Already sent under this reference (an earlier attempt timed out): its status is the answer.
      if (err instanceof ProviderError && err.code === 'DUPLICATE') return this.getTransfer(input.reference);
      throw err;
    }
  }

  /**
   * The sender name for transfers from the business account: whatever name
   * enquiry says, so it always matches the bank's record. Cached for the
   * process; a failed lookup isn't cached, so the next transfer retries it.
   */
  private getBusinessAccountName(): Promise<string> {
    this.businessAccountName ??= this.nameEnquiry(this.config.bankCode, this.config.businessAccountNumber).then((found) => {
      if (!found) throw new ProviderError('The business account could not be verified with 9jaPay', null, 'BUSINESS_ACCOUNT_UNVERIFIABLE', true);
      return found.accountName;
    });
    return this.businessAccountName.catch((err) => {
      this.businessAccountName = null;
      throw err;
    });
  }

  async getTransfer(reference: string): Promise<TransferResult> {
    const wire = this.wireReference(reference);
    const res = await this.client.request<Transfer>({
      method: 'GET',
      path: `/v1/api/transfers/tsq/${encodeURIComponent(wire)}`,
      op: 'transfer.status',
      ref: reference,
    });
    // The outer status is the query's; data.status is the transfer's.
    const state = mapTransferStatus(res.data?.status);
    return {
      providerReference: wire,
      state: res.data?.status ? state : 'processing',
      failureReason: state === 'failed' ? 'The bank could not complete the transfer' : null,
    };
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

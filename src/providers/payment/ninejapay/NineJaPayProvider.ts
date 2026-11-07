import { logger } from '../../../lib/logger';
import {
  InvalidSignatureError,
  ProviderError,
  type Bank,
  type CollectionAccount,
  type CollectionCredit,
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
import { normaliseNineJaPayEvent, parseNineJaPayDate, SPACE_ACCOUNT_PREFIX } from './events';
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
const TRANSACTION_PAGE_SIZE = 50;
/** 1,000 rows: far beyond any one account's history; hitting it means something is wrong. */
const TRANSACTION_PAGE_LIMIT = 20;
/** Fresh references tried when opening a space account keeps hitting a duplicate. */
const SPACE_ACCOUNT_ATTEMPTS = 5;

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

export { parseNineJaPayDate };

/** YYYY-MM-DD of an instant in Lagos (UTC+1), shifted by whole days. */
function lagosDate(at: Date, shiftDays = 0): string {
  return new Date(at.getTime() + 60 * 60 * 1000 + shiftDays * 86_400_000).toISOString().slice(0, 10);
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

function mapTransferStatus(raw: string | undefined): TransferState {
  switch ((raw ?? '').toLowerCase()) {
    case 'success':
    case 'successful':
      return 'succeeded';
    case 'failed':
    case 'reversed':
      return 'failed';
    default:
      return 'processing';
  }
}

/**
 * A transfer's state from the create response. The envelope's status is the
 * request's, not the transfer's (TSQ answers outer SUCCESS for a Failed
 * transfer), so data.status wins. Without it, "01" means processing and only
 * an explicit "00" counts as done.
 */
function createdTransferState(res: { status?: string; statusCode?: string; data?: Transfer }): TransferState {
  if (res.data?.status) return mapTransferStatus(res.data.status);
  if (res.statusCode === '00') return 'succeeded';
  return 'processing';
}

export class NineJaPayProvider implements PaymentProvider {
  readonly name = 'ninejapay';
  private readonly client: NineJaPayClient;
  /** Sending accounts' names as the bank holds them, looked up once per process. */
  private readonly senderNames = new Map<string, Promise<string>>();

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
    // A reused number accumulates two rows per checkout (credit + closure
    // debit), so the window's credit can be past page 1. Read every page.
    const rows: Transaction[] = [];
    for (let page = 1; page <= TRANSACTION_PAGE_LIMIT; page++) {
      const res = await this.client.request<Transaction[]>({
        method: 'GET',
        path: '/v1/api/transactions',
        op: 'collection.transactions',
        query: {
          'page-size': String(TRANSACTION_PAGE_SIZE),
          'page-number': String(page),
          'account-number': accountNumber,
          // Day filters (inclusive, timezone unstated), so a day's margin each side;
          // the exact window is applied below.
          'start-date': lagosDate(window.from, -1),
          'end-date': lagosDate(window.to, 1),
        },
      });
      const batch = res.data ?? [];
      rows.push(...batch);
      if (batch.length < TRANSACTION_PAGE_SIZE) break;
      if (page === TRANSACTION_PAGE_LIMIT) throw new ProviderError(`9jaPay transactions for ${accountNumber} run past ${page} pages`, null, null, true);
    }

    const credits: CollectionCredit[] = [];
    for (const t of rows) {
      if ((t.transactionType ?? '').toLowerCase() !== 'credit' || (t.accountNumber ?? accountNumber) !== accountNumber) continue;
      const at = parseNineJaPayDate(t.transactionDate);
      if (at === null || at < window.from || at > window.to || !t.transactionId) continue;
      credits.push({ transactionId: String(t.transactionId), amountKobo: Number(t.amount ?? 0), at });
    }
    credits.sort((a, b) => a.at.getTime() - b.at.getTime());
    if (credits.length === 0) return { state: 'open', receivedKobo: null, credits };
    return { state: 'paid', receivedKobo: credits.reduce((sum, c) => sum + c.amountKobo, 0), credits };
  }

  /**
   * A timed-out attempt may have opened the account, and 9jaPay then refuses
   * the same reference as a duplicate without saying which number it gave
   * (no lookup by reference). Rather than block the space for good, open it
   * under the next reference (SPACE<id>, SPACE<id>R1, …); the account the lost
   * attempt opened, if any, is unused and logged for cleanup.
   */
  async createSpaceAccount(input: CreateSpaceAccountInput): Promise<SpaceAccount> {
    const base = `${SPACE_ACCOUNT_PREFIX}${this.wireReference(input.reference)}`;
    let res: { data?: CreatedAccount } | null = null;
    for (let attempt = 0; attempt < SPACE_ACCOUNT_ATTEMPTS && !res; attempt++) {
      const reference = attempt === 0 ? base : `${base}R${attempt}`;
      try {
        res = await this.client.request<CreatedAccount>({
          method: 'POST',
          path: '/v1/api/virtual-accounts/permanent',
          op: 'space_account.create',
          ref: input.reference,
          body: { requestReference: reference, accountName: input.accountName, autoPayoutEnabled: false },
        });
      } catch (err) {
        if (!(err instanceof ProviderError && err.code === 'DUPLICATE')) throw err;
        logger.warn({ spaceRef: input.reference, requestReference: reference }, 'space account reference already used (an earlier attempt may have opened an unused account); trying the next');
      }
    }
    if (!res) throw new ProviderError(`Every space account reference for ${input.reference} is already used`, null, 'DUPLICATE', false);
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
    const senderAccount = input.from === 'business' ? this.config.businessAccountNumber : input.from.accountNumber;
    const sender = { accountNumber: senderAccount, accountName: await this.getSenderName(senderAccount) };
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
      const state = createdTransferState(res);
      return { providerReference: reference, state, failureReason: state === 'failed' ? 'The bank could not complete the transfer' : null };
    } catch (err) {
      // Already sent under this reference (an earlier attempt timed out): its status is the answer.
      if (err instanceof ProviderError && err.code === 'DUPLICATE') return this.getTransfer(input.reference);
      throw err;
    }
  }

  /**
   * The sender name for a transfer, from the business account (a sweep) or a
   * space's account (a withdrawal): whatever name enquiry says, so it always
   * matches the bank's record ("DUEVY/<space>" for a space). Cached for the
   * process; a failed lookup isn't cached, so the next transfer retries it.
   */
  private getSenderName(accountNumber: string): Promise<string> {
    let name = this.senderNames.get(accountNumber);
    if (!name) {
      name = this.nameEnquiry(this.config.bankCode, accountNumber).then((found) => {
        if (!found) throw new ProviderError(`Sending account ${accountNumber} could not be verified with 9jaPay`, null, 'SENDER_UNVERIFIABLE', true);
        return found.accountName;
      });
      this.senderNames.set(accountNumber, name);
    }
    return name.catch((err) => {
      this.senderNames.delete(accountNumber);
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

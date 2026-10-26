import { decimalToKobo, koboToDecimal, krediPayoutCostKobo } from '../../../lib/money';
import { logger } from '../../../lib/logger';
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
import { KrediClient } from './client';
import { normaliseKrediEvent } from './events';
import { computeKrediSignature, verifyKrediSignature } from './signature';

/**
 * Kredi Pay as Duevy's payment rail (see docs/KREDI.md).
 *
 *  - Collections: one temporary account per checkout (generate_account), shown
 *    on Duevy's own pay page. The student's money settles into Duevy's
 *    merchant account; Kredi keeps a flat ₦20.
 *  - Payouts: Payout V2 `fundtransfer` from the merchant account to the
 *    beneficiary's bank. The per-space ledger decides how much a space may
 *    withdraw — Kredi holds one pooled balance.
 *  - Reps: each verified rep is registered as a Kredi customer (BVN-backed).
 *    It is Kredi's record of who the rep is; no money is routed through it.
 */

/** POST /api/generate_account, as the Kredi test environment returns it. */
interface KrediGeneratedAccount {
  id?: string;
  transaction_ref?: string | null;
  amount?: string;
  /** The account name the customer sees, e.g. "Duevy Labs Ltd". */
  name?: string;
  account?: { nuban?: string; created_at?: string; expired_at?: string };
  status?: number;
  expiry?: { expired_in?: number; unit?: string; expired_at?: string };
}
interface KrediCustomer {
  id: string;
  nuban?: string | null;
}
interface KrediNameEnquiry {
  accountNumber?: string;
  accountName?: string;
  kycLevel?: string | number | null;
  bvn?: string | null;
  responseCode?: string;
}
interface KrediBank {
  nipCode?: string;
  institutionCode?: string;
  institutionName?: string;
}
interface KrediTransfer {
  code?: number | string;
  responseCode?: string;
  responseMessage?: string;
  message?: string;
  transactionRef?: string;
  cbaTransactionId?: string;
}
interface KrediTransferRecord {
  krediReference?: string;
  yourReference?: string;
  status?: { code?: number | string; status_message?: string };
  transaction_status_message?: string;
}
interface KrediBalance {
  availableBalance?: string | number;
  accountBalance?: string | number;
}

export interface KrediProviderConfig {
  baseUrl: string;
  apiKey: string;
  authToken: string;
  webhookSecrets: string[];
  /** The collection host (generate_account), separate from the payout host. */
  collectionBaseUrl: string;
  /** Where Kredi posts a collection's webhook. */
  collectionWebhookUrl: string;
}

/** Kredi wants amounts as a float of naira. Exact for any kobo value we hold. */
function naira(kobo: number): number {
  return Number(koboToDecimal(kobo));
}

/** +2348101234520 → 08101234520 (the format Kredi's customer API uses). */
export function localPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
}

/** "OBI, ADA C." and "Ada Obi C" are the same holder; word order varies by bank. */
export function sameAccountHolder(a: string, b: string): boolean {
  const words = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .sort()
      .join(' ');
  return words(a) === words(b);
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? 'Duevy', last: parts.length > 1 ? (parts[parts.length - 1] as string) : (parts[0] ?? 'Payer') };
}

const UNIT_MS: Record<string, number> = { minute: 60_000, minutes: 60_000, hour: 3_600_000, hours: 3_600_000 };

/**
 * created_at + expired_in (hours on test, 30 minutes on production per Kredi);
 * falls back to our own window if Kredi leaves either out or uses another unit.
 */
function accountExpiry(data: KrediGeneratedAccount, fallbackMinutes: number): Date {
  const created = data.account?.created_at ? Date.parse(data.account.created_at) : NaN;
  const unitMs = UNIT_MS[(data.expiry?.unit ?? '').toLowerCase()];
  const amount = data.expiry?.expired_in;
  if (!Number.isNaN(created) && unitMs && typeof amount === 'number') return new Date(created + amount * unitMs);
  return new Date(Date.now() + fallbackMinutes * 60_000);
}

function mapTransfer(reference: string, data: KrediTransfer | undefined, amountKobo: number): PayoutResult {
  const providerPayoutId = data?.cbaTransactionId ?? data?.transactionRef ?? reference;
  const code = Number(data?.code);
  const state =
    data?.responseCode === '00' || code === 200 ? 'succeeded' : code === 401 ? 'failed' : 'processing';
  return {
    providerPayoutId,
    state,
    providerFeeKobo: krediPayoutCostKobo(amountKobo),
    failureReason: state === 'failed' ? (data?.responseMessage ?? data?.message ?? null) : null,
  };
}

export class KrediProvider implements PaymentProvider {
  readonly name = 'kredi';
  private readonly client: KrediClient;
  private readonly collections: KrediClient;

  constructor(private readonly config: KrediProviderConfig) {
    this.client = new KrediClient(config.baseUrl, config.apiKey, config.authToken);
    this.collections = new KrediClient(config.collectionBaseUrl, config.apiKey, config.authToken);
  }

  // -------------------------------------------------------------------------
  // Collections
  // -------------------------------------------------------------------------

  /**
   * A temporary account for exactly face + fee, shown on Duevy's pay page.
   * Kredi posts the collection webhook to `collectionWebhookUrl` when money
   * arrives; that webhook decides whether the checkout is paid.
   *
   * The account's life comes from Kredi (48 hours on test, 30 minutes on
   * production): `created_at` (UTC) plus `expiry.expired_in` in `expiry.unit`. `account.expired_at` has no timezone, so it
   * isn't used.
   */
  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    const totalKobo = input.faceKobo + input.platformFeeKobo;
    const { first, last } = splitName(input.customer.name);
    const res = await this.collections.request<KrediGeneratedAccount>({
      method: 'POST',
      path: '/api/generate_account',
      op: 'collection.create',
      ref: input.reference,
      body: {
        transaction_ref: input.reference,
        amount: koboToDecimal(totalKobo),
        currency: 'NGN',
        redirect_url: input.returnUrl,
        webhook_url: this.config.collectionWebhookUrl,
        customer: {
          first_name: first,
          last_name: last,
          email: input.customer.email,
          phone_number: localPhone(input.customer.phone),
        },
      },
    });
    const data = res.data;
    const nuban = data?.account?.nuban;
    if (!data?.id || !nuban) throw new ProviderError('Kredi did not return an account', null, 'NO_ACCOUNT', true);
    if (data.amount !== undefined && decimalToKobo(data.amount) !== totalKobo) {
      throw new ProviderError('Kredi priced the account differently', null, 'PRICE_MISMATCH', false);
    }
    return {
      providerCheckoutId: data.id,
      providerChargeId: null,
      accountNumber: nuban,
      // Not in the response; Kredi to confirm what customers should be shown.
      bankName: null,
      accountName: data.name ?? null,
      checkoutUrl: null,
      totalKobo,
      expiresAt: accountExpiry(data, input.expiresInMinutes),
    };
  }

  /**
   * Kredi has no documented way to look a collection up by our reference (the
   * payment log doesn't filter on it, and errors on the collection host), so
   * the collection webhook is the only signal. Until there is one, this
   * reports `open` and reconciliation leaves the checkout to its expiry —
   * money arriving after that is still honoured.
   */
  async getCollectionStatus(_providerCheckoutId: string): Promise<CollectionStatus> {
    return { state: 'open', receivedKobo: null };
  }

  // -------------------------------------------------------------------------
  // Reps
  // -------------------------------------------------------------------------

  /** Register the rep as a Kredi customer. Duevy has already matched their phone and BVN. */
  async verifyIdentity(input: VerifyIdentityInput): Promise<IdentityResult> {
    const bvn = input.idNumbers.find((n) => n.type === 'bvn')?.value;
    if (!bvn) throw new ProviderError('A BVN is required', 422, 'VALIDATION_ERROR', false);
    const res = await this.client.request<KrediCustomer>({
      method: 'POST',
      path: '/api/wallet/customers/create',
      op: 'customer.create',
      body: {
        first_name: input.profile.firstName,
        middle_name: '',
        last_name: input.profile.lastName,
        phone: localPhone(input.profile.phone),
        email: input.profile.email,
        gender: input.gender,
        country: 'Nigeria',
        address: input.address,
        bvn,
      },
    });
    if (!res.data?.id) throw new ProviderError('Kredi did not return a customer id', null, 'NO_CUSTOMER', true);
    return { accountId: res.data.id, accountNumber: res.data.nuban ?? null, status: 'verified', payoutsActive: true, failureReason: null };
  }

  async getIdentityStatus(accountId: string): Promise<IdentityResult> {
    const res = await this.client.request<KrediCustomer>({ method: 'GET', path: `/api/wallet/customers/${encodeURIComponent(accountId)}`, op: 'customer.get' });
    return { accountId, accountNumber: res.data?.nuban ?? null, status: 'verified', payoutsActive: true, failureReason: null };
  }

  // -------------------------------------------------------------------------
  // Banks
  // -------------------------------------------------------------------------

  /**
   * The wallet API's bank list (`/api/wallet/customers/banks`). The Payout V2
   * copy (`/api/kredipay/banks`) returns the same data but is closed to us on
   * test. Several banks share a NIP code (e.g. Access and Access (Diamond));
   * the first name listed for a code is kept, so codes stay unique.
   */
  async listBanks(): Promise<Bank[]> {
    const res = await this.client.request<KrediBank[]>({ method: 'GET', path: '/api/wallet/customers/banks', op: 'banks.list' });
    const byCode = new Map<string, string>();
    for (const b of Array.isArray(res.data) ? res.data : []) {
      if (b.nipCode && b.institutionName && !byCode.has(b.nipCode)) byCode.set(b.nipCode, b.institutionName);
    }
    return [...byCode].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    let res;
    try {
      // The wallet API's beneficiary enquiry; the Payout V2 one
      // (/api/kredipay/nameenquiry) is closed to us on test.
      res = await this.client.request<KrediNameEnquiry>({
        method: 'POST',
        path: '/api/wallet/customers/account-enquiry',
        body: { account_no: accountNumber, bank_code: bankCode },
        op: 'banks.resolve',
      });
    } catch (err) {
      // A definite refusal means the bank can't find the account.
      if (err instanceof ProviderError && !err.retryable) return null;
      throw err;
    }
    const name = res.data?.accountName?.trim();
    if (!name) return null;
    return { accountName: name, bvn: res.data?.bvn ?? null, kycLevel: res.data?.kycLevel == null ? null : String(res.data.kycLevel) };
  }

  // -------------------------------------------------------------------------
  // Payouts (Payout V2)
  // -------------------------------------------------------------------------

  /**
   * One V2 transfer from the merchant account. The name enquiry is repeated
   * first: V2 needs the holder's BVN and KYC level (never stored), and an
   * account whose holder changed since it was saved is refused rather than paid.
   */
  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult> {
    const { destination, amountKobo, reference } = input;
    const holder = await this.resolveAccount(destination.bankCode, destination.accountNumber);
    if (!holder) throw new ProviderError('The bank could not verify this account', 422, 'ACCOUNT_UNVERIFIABLE', false);
    if (!sameAccountHolder(holder.accountName, destination.accountName)) {
      throw new ProviderError('The account holder has changed since this account was saved', 422, 'ACCOUNT_CHANGED', false);
    }

    const amount = naira(amountKobo);
    try {
      const res = await this.client.request<KrediTransfer>({
        method: 'POST',
        path: '/api/kredipay/fundtransfer',
        op: 'payout.create',
        ref: reference,
        // Payout V2 (async) signs each transfer: sha512 of
        // "transactionAmount-merchantSecret-transactionReference".
        headers: { 'signature-key': computeKrediSignature(String(amount), this.config.webhookSecrets[0] as string, reference) },
        body: {
          transaction_reference: reference,
          transaction_amount: amount,
          beneficiary_account_no: destination.accountNumber,
          beneficiary_account_name: holder.accountName,
          beneficiary_entity_code: destination.bankCode,
          beneficiary_bvn: holder.bvn ?? '',
          ...(holder.kycLevel ? { beneficiary_kyc_level: holder.kycLevel } : {}),
          narration: `Duevy payout ${reference}`,
        },
      });
      return mapTransfer(reference, res.data, amountKobo);
    } catch (err) {
      // We sent this reference before (a retry after a timeout): its fate is
      // whatever Kredi recorded the first time, never a second transfer.
      if (err instanceof ProviderError && err.code === 'DUPLICATE_REFERENCE') {
        logger.info({ ref: reference }, 'payout reference already used at Kredi — reading its outcome');
        return this.getPayout(reference);
      }
      throw err;
    }
  }

  /**
   * TSQ by our reference; `responseCode "00"` is a completed transfer. Anything
   * else is checked against the transaction search, which carries Kredi's own
   * 200 / 401 status. Without a final answer the payout stays processing —
   * a withdrawal is never failed (and its balance restored) on a guess.
   */
  async getPayout(reference: string): Promise<PayoutResult> {
    const fee = null;
    try {
      const tsq = await this.client.request<KrediTransfer>({
        method: 'GET',
        path: `/api/kredipay/transactions/${encodeURIComponent(reference)}`,
        op: 'payout.tsq',
        ref: reference,
      });
      if (tsq.data?.responseCode === '00') {
        return { providerPayoutId: tsq.data.cbaTransactionId ?? reference, state: 'succeeded', providerFeeKobo: fee, failureReason: null };
      }
    } catch (err) {
      if (!(err instanceof ProviderError) || err.retryable) throw err;
      // NOT_FOUND and other refusals: fall through to the search.
    }

    const search = await this.client.request<{ data?: KrediTransferRecord[] } | KrediTransferRecord[]>({
      method: 'GET',
      path: '/api/v2/transactions/search',
      query: { yourReference: reference },
      op: 'payout.search',
      ref: reference,
    });
    const rows = Array.isArray(search.data) ? search.data : (search.data?.data ?? []);
    const row = rows.find((r) => r.yourReference === reference);
    const code = Number(row?.status?.code);
    if (code === 200) return { providerPayoutId: row?.krediReference ?? reference, state: 'succeeded', providerFeeKobo: fee, failureReason: null };
    if (code === 401) {
      return {
        providerPayoutId: row?.krediReference ?? reference,
        state: 'failed',
        providerFeeKobo: fee,
        failureReason: row?.transaction_status_message ?? row?.status?.status_message ?? null,
      };
    }
    return { providerPayoutId: row?.krediReference ?? reference, state: row ? 'processing' : 'pending', providerFeeKobo: fee, failureReason: null };
  }

  async getPlatformBalance(): Promise<{ availableKobo: number }> {
    const res = await this.client.request<KrediBalance>({ method: 'GET', path: '/api/wallet/account/balance', op: 'balance.get' });
    const raw = res.data?.availableBalance ?? res.data?.accountBalance;
    if (raw === undefined || raw === null) throw new ProviderError('Kredi did not return a balance', null, null, true);
    return { availableKobo: decimalToKobo(Math.max(0, Number(raw))) };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyKrediSignature(rawBody, headers, this.config.webhookSecrets);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    return normaliseKrediEvent(JSON.parse(rawBody.toString('utf8')));
  }
}

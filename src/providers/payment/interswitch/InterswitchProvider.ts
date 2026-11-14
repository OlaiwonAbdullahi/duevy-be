import { logger } from '../../../lib/logger';
import { plainAscii, TRANSFER_NARRATION_MAX } from '../../../lib/narration';
import {
  InvalidSignatureError,
  ProviderError,
  type AccountCredit,
  type Bank,
  type GatewayCheckoutParams,
  type GatewayCheckoutStatus,
  type CollectionAccount,
  type CollectionStatus,
  type CreateGatewayCheckoutInput,
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
import { InterswitchClient, type InterswitchConfig } from './client';
import { normaliseInterswitchEvent } from './events';
import { MalformedEventError } from '../ninejapay/events';
import { verifyInterswitchSignature } from './signature';

/**
 * Interswitch as Duevy's payment rail (docs/INTERSWITCH.md).
 *
 *  - Students pay through IPG Web Checkout, which shows EVERY method enabled for
 *    the merchant (card, bank transfer, USSD, QR, …) — not just card. The
 *    one-time "account" is the per-attempt txn_ref (= our checkout reference,
 *    non-alphanumerics stripped). createGatewayCheckout builds the inline-popup
 *    params; the outcome is read back from gettransaction.json and accepted only
 *    on ResponseCode "00" with a matching amount, whatever method was used.
 *    (collectsByGateway = true, so the checkout service never opens a one-time
 *    bank account here.)
 *  - Each space has a permanent Interswitch Virtual Account; withdrawals leave
 *    through the Payouts API.
 *
 * Several VA / payout / name-enquiry field names are confirmed per-merchant in
 * the Quickteller Business portal; those calls are marked below and isolated so
 * only this file and client.ts change if a shape differs.
 */

const BANK_NAME = 'Interswitch';
/** Interswitch's settlement bank code for the virtual accounts (confirm in portal). */
const DEFAULT_BANK_CODE = '000';
export const SPACE_ACCOUNT_PREFIX = 'SPACE';
/** gettransaction.json / most Interswitch APIs use "00" for success. */
const SUCCESS_CODE = '00';

function field(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return undefined;
}
function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function mapTransferStatus(raw: string | null): TransferState {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
    case 'successful':
    case 'success':
    case 'paid':
    case '00':
      return 'succeeded';
    case 'failed':
    case 'reversed':
    case 'declined':
      return 'failed';
    default:
      return 'processing';
  }
}

export class InterswitchProvider implements PaymentProvider {
  readonly name = 'interswitch';
  readonly collectsByGateway = true;
  private readonly client: InterswitchClient;

  constructor(private readonly cfg: InterswitchConfig) {
    this.client = new InterswitchClient(cfg);
  }

  /** Interswitch txn_ref: letters and digits only (strip our hyphens). */
  wireReference(reference: string): string {
    return reference.replace(/[^A-Za-z0-9]/g, '');
  }

  // -------------------------------------------------------------------------
  // Gateway checkout (IPG Web Checkout) — the student paywall.
  // The popup shows all methods enabled for the merchant (card, bank transfer,
  // USSD, QR, …); the set is configured in the Quickteller Business dashboard,
  // not restricted here.
  // -------------------------------------------------------------------------

  createGatewayCheckout(input: CreateGatewayCheckoutInput): GatewayCheckoutParams {
    return {
      provider: this.name,
      scriptUrl: this.cfg.inlineCheckoutUrl,
      merchantCode: this.cfg.merchantCode,
      payItemId: this.cfg.payItemId,
      txnRef: this.wireReference(input.reference),
      amountKobo: input.totalKobo,
      currency: this.cfg.currency,
      mode: this.cfg.env === 'live' ? 'LIVE' : 'TEST',
      redirectUrl: input.redirectUrl,
    };
  }

  /**
   * Requery Web Checkout for a transaction's outcome (checklist step: the
   * server re-reads /collections/api/v1/gettransaction.json and accepts the
   * payment only when ResponseCode is "00" and the amount matches). Amounts
   * are in minor units (kobo), the same as everywhere in Duevy.
   */
  async verifyGatewayCheckout(reference: string, amountKobo: number): Promise<GatewayCheckoutStatus> {
    const txnRef = this.wireReference(reference);
    const body = await this.client.request<Record<string, unknown>>({
      method: 'GET',
      baseUrl: this.cfg.collectionsUrl,
      path: 'collections/api/v1/gettransaction.json',
      auth: false,
      op: 'checkout.query',
      ref: reference,
      query: {
        merchantcode: this.cfg.merchantCode,
        transactionreference: txnRef,
        amount: String(amountKobo),
      },
    });

    const responseCode = str(field(body, 'ResponseCode', 'responseCode')) ?? null;
    const received = num(field(body, 'Amount', 'amount'));
    const transactionId =
      str(field(body, 'PaymentReference', 'paymentReference')) ??
      str(field(body, 'RetrievalReferenceNumber', 'retrievalReferenceNumber', 'rrn'));

    if (responseCode === SUCCESS_CODE && received !== null) {
      if (received === amountKobo) {
        return { state: 'paid', receivedKobo: received, transactionId, responseCode };
      }
      // Approved but the amount differs from what we expect: never auto-accept
      // (checklist: "00 AND the amount matches"). Leave it for a human.
      logger.warn({ ref: reference, received, expected: amountKobo }, 'interswitch approved a different amount than expected; not accepting');
      return { state: 'open', receivedKobo: received, transactionId, responseCode };
    }
    // Not approved yet (pending popup, abandoned/declined payment, or unknown reference).
    return { state: 'open', receivedKobo: received, transactionId: null, responseCode };
  }

  // -------------------------------------------------------------------------
  // One-time bank account — NOT used on a gateway rail
  // -------------------------------------------------------------------------

  async createCollectionAccount(_input: CreateCollectionInput): Promise<CollectionAccount> {
    throw new ProviderError('Interswitch collects via the IPG gateway; one-time bank accounts are not used', null, 'NOT_SUPPORTED', false);
  }

  async getCollectionStatus(_accountNumber: string, _window: { from: Date; to: Date }): Promise<CollectionStatus> {
    throw new ProviderError('Interswitch collects via the IPG gateway; getCollectionStatus is not used', null, 'NOT_SUPPORTED', false);
  }

  // -------------------------------------------------------------------------
  // Space permanent account — Interswitch Virtual Accounts
  // -------------------------------------------------------------------------

  /** ⚠️ Confirm the VA-create endpoint + payload in the Quickteller Business portal. */
  async createSpaceAccount(input: CreateSpaceAccountInput): Promise<SpaceAccount> {
    const requestReference = `${SPACE_ACCOUNT_PREFIX}${this.wireReference(input.reference)}`;
    const res = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      baseUrl: this.cfg.vaUrl,
      path: 'api/v1/virtualaccounts',
      op: 'space_account.create',
      ref: input.reference,
      body: {
        merchantCode: this.cfg.merchantCode,
        currencyCode: this.cfg.currency,
        accountName: input.accountName,
        transactionReference: requestReference,
        // A permanent account that accepts many payments (not tied to one amount).
        isPermanent: true,
      },
    });
    const data = (field(res, 'data') as Record<string, unknown>) ?? res;
    const accountNumber = str(field(data, 'accountNumber', 'virtualAccountNumber', 'nuban'));
    if (!accountNumber) throw new ProviderError('Interswitch returned no account number', null, null, false);
    return {
      accountId: str(field(data, 'id', 'accountId')) ?? accountNumber,
      accountNumber,
      accountName: str(field(data, 'accountName')) ?? input.accountName,
      bankName: str(field(data, 'bankName')) ?? BANK_NAME,
      bankCode: str(field(data, 'bankCode')) ?? DEFAULT_BANK_CODE,
    };
  }

  /** VA rename is best-effort: Interswitch may not support it, so keep the name we have. */
  async renameSpaceAccount(_accountNumber: string, accountName: string): Promise<{ accountName: string }> {
    return { accountName };
  }

  /** ⚠️ Confirm the VA transactions endpoint in the portal; tolerant by design. */
  async listAccountCredits(accountNumber: string, window: { from: Date; to: Date }): Promise<AccountCredit[]> {
    let res: Record<string, unknown>;
    try {
      res = await this.client.request<Record<string, unknown>>({
        method: 'GET',
        baseUrl: this.cfg.vaUrl,
        path: `api/v1/virtualaccounts/${encodeURIComponent(accountNumber)}/transactions`,
        op: 'account.transactions',
        query: { startDate: window.from.toISOString().slice(0, 10), endDate: window.to.toISOString().slice(0, 10) },
      });
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) throw err;
      logger.warn({ accountNumber, err: (err as Error).message }, 'interswitch VA transactions unavailable; treating as none');
      return [];
    }
    const rows = (field(res, 'data', 'transactions') as unknown[]) ?? [];
    const credits: AccountCredit[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const t = row as Record<string, unknown>;
      const amountKobo = num(field(t, 'amount', 'Amount'));
      const id = str(field(t, 'transactionId', 'paymentReference', 'id', 'rrn'));
      const whenRaw = str(field(t, 'transactionDate', 'paymentDate', 'date'));
      const at = whenRaw ? new Date(whenRaw) : null;
      if (!id || amountKobo === null || !at || Number.isNaN(at.getTime())) continue;
      if (at < window.from || at > window.to) continue;
      credits.push({
        transactionId: id,
        amountKobo,
        at,
        source: 'external',
        senderName: str(field(t, 'senderName', 'payerName')),
        senderAccountNumber: str(field(t, 'senderAccountNumber')),
        senderBank: str(field(t, 'senderBank')),
        narration: str(field(t, 'narration', 'remarks')),
      });
    }
    return credits.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  // -------------------------------------------------------------------------
  // Name enquiry, banks
  // -------------------------------------------------------------------------

  /** ⚠️ Confirm the name-enquiry endpoint in the portal; returns null when unresolved. */
  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    try {
      const res = await this.client.request<Record<string, unknown>>({
        method: 'GET',
        baseUrl: this.cfg.payoutsUrl,
        path: 'accounts/name-enquiry',
        op: 'name_enquiry',
        query: { bankCode, accountNumber },
      });
      const data = (field(res, 'data') as Record<string, unknown>) ?? res;
      const name = str(field(data, 'accountName', 'AccountName', 'name'));
      return name ? { accountName: name } : null;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) throw err;
      return null;
    }
  }

  /** ⚠️ Confirm the bank-list endpoint; falls back to an empty list on failure. */
  async listBanks(): Promise<Bank[]> {
    try {
      const res = await this.client.request<Record<string, unknown>>({
        method: 'GET',
        baseUrl: this.cfg.payoutsUrl,
        path: 'banks',
        op: 'banks.list',
      });
      const rows = (field(res, 'data', 'banks') as unknown[]) ?? [];
      return (Array.isArray(rows) ? rows : [])
        .map((r) => {
          const b = r as Record<string, unknown>;
          const code = str(field(b, 'code', 'bankCode', 'cbnCode'));
          const name = str(field(b, 'name', 'bankName'));
          return code && name ? { code, name } : null;
        })
        .filter((b): b is Bank => b !== null);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'interswitch bank list unavailable');
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Transfers — Payouts API (space account → beneficiary bank)
  // -------------------------------------------------------------------------

  /** ⚠️ Confirm the Payouts request/response fields (singleCall) in the portal. */
  async initiateTransfer(input: InitiateTransferInput): Promise<TransferResult> {
    const reference = this.wireReference(input.reference);
    try {
      const res = await this.client.request<Record<string, unknown>>({
        method: 'POST',
        baseUrl: this.cfg.payoutsUrl,
        path: '',
        op: input.from === 'business' ? 'sweep.create' : 'payout.create',
        ref: input.reference,
        body: {
          merchantCode: this.cfg.merchantCode,
          amount: input.amountKobo,
          currencyCode: this.cfg.currency,
          // lookup + payout in one call.
          singleCall: true,
          beneficiaryAccountNumber: input.accountNumber,
          beneficiaryBankCode: input.bankCode,
          beneficiaryName: input.accountName,
          narration: fitNarration(input.narration),
          transactionReference: reference,
        },
      });
      const data = (field(res, 'data') as Record<string, unknown>) ?? res;
      const state = mapTransferStatus(str(field(data, 'status', 'responseCode', 'ResponseCode')));
      return {
        providerReference: reference,
        state,
        failureReason: state === 'failed' ? 'The bank could not complete the transfer' : null,
      };
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'DUPLICATE') return this.getTransfer(input.reference);
      throw err;
    }
  }

  async getTransfer(reference: string): Promise<TransferResult> {
    const wire = this.wireReference(reference);
    const res = await this.client.request<Record<string, unknown>>({
      method: 'GET',
      baseUrl: this.cfg.payoutsUrl,
      path: encodeURIComponent(wire),
      op: 'transfer.status',
      ref: reference,
    });
    const data = (field(res, 'data') as Record<string, unknown>) ?? res;
    const raw = str(field(data, 'status', 'responseCode', 'ResponseCode'));
    const state = mapTransferStatus(raw);
    return {
      providerReference: wire,
      state: raw ? state : 'processing',
      failureReason: state === 'failed' ? 'The bank could not complete the transfer' : null,
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyInterswitchSignature(rawBody, headers, this.cfg.webhookSecret, this.cfg.env);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new MalformedEventError(null, null, 'webhook body is not JSON');
    }
    return normaliseInterswitchEvent(body, { spaceAccountPrefix: SPACE_ACCOUNT_PREFIX });
  }
}

/** Interswitch narration cap mirrors the shared transfer limit. */
export const NARRATION_MAX = TRANSFER_NARRATION_MAX;
export function fitNarration(text: string): string {
  const plain = plainAscii(text);
  return plain.length <= NARRATION_MAX ? plain : plain.slice(0, NARRATION_MAX).trimEnd();
}

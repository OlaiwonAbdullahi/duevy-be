import { decrypt, encrypt } from '../../../lib/encryption';
import { logger } from '../../../lib/logger';
import { decimalToKobo, koboToNaira } from '../../../lib/money';
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
} from '../types';
import { Bank78Client, type Bank78Credentials } from './client';
import { normaliseBank78Event } from './events';
import { payoutStateFromCode, payoutStateFromStatus } from './responseCodes';
import { verifyBank78Signature } from './signature';

/**
 * Bank78 — the payment rail.
 *
 *  - A student pays each checkout into a DYNAMIC virtual account (Virtual
 *    NUBAN) opened for exactly the checkout total. It lands in Duevy's
 *    merchant collection account.
 *  - Each rep has a wallet: a Bank78 sub-account. Once a checkout is paid, its
 *    face amount is routed from the merchant account into the lead rep's
 *    wallet (routeCollection); Duevy's fee stays behind.
 *  - Withdrawals are paid out of the rep's wallet to any bank.
 *
 * Bank78 amounts are naira numbers; everything here converts at the edge.
 */

/** Bank78's own NIP institution code, for transfers into a Bank78 account. */
const BANK78_BANK_CODE = '110072';
const BANK78_BANK_NAME = 'Bank78';

interface VirtualNubanResult {
  accountNumber: string;
  accountReference: string;
  accountName: string;
  bankName: string | null;
  reservationReference?: string;
  isActive?: boolean;
}

interface SubAccountResult {
  accountNumber: string;
  bankName?: string | null;
  isActive?: boolean;
  availableBalance?: number | null;
}

interface TransferResult {
  amount?: number;
  reference?: string;
  status?: string;
  responseCode?: string;
  fee?: number | null;
  message?: string;
}

/** What registerPayoutDestination hands back, sealed: Bank78 keeps no destination objects. */
interface SealedDestination {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface Bank78Options extends Bank78Credentials {
  webhookSecrets: string[];
  webhookToleranceSeconds: number;
}

function naira(kobo: number): number {
  return koboToNaira(kobo);
}

function kobo(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  return decimalToKobo(value);
}

export class Bank78Provider implements PaymentProvider {
  readonly name = 'bank78';
  private readonly client: Bank78Client;

  constructor(private readonly opts: Bank78Options) {
    this.client = new Bank78Client(opts);
  }

  // --- collections -------------------------------------------------------------

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    const totalKobo = input.faceKobo + input.platformFeeKobo;
    let account: VirtualNubanResult;
    try {
      account = await this.client.request<VirtualNubanResult>({
        method: 'POST',
        path: '/virtual-nuban/api/virtual-nubans',
        op: 'collection.create',
        ref: input.reference,
        idempotencyKey: input.reference,
        body: {
          accountReference: input.reference,
          accountName: `Duevy ${input.customer.name}`.slice(0, 60),
          emailAddress: input.customer.email,
          phoneNumber: '',
          bvn: '',
          accountType: 2, // dynamic: one checkout, then it closes
          expiresInMinutes: input.expiresInMinutes,
          amountConstraint: 0, // Exact: Bank78 refuses any other amount
          amount: naira(totalKobo),
        },
      });
    } catch (err) {
      // A retry after a timeout hits the reference we already reserved. The
      // account is ours, so pick it up instead of failing the checkout.
      if (!(err instanceof ProviderError) || err.retryable) throw err;
      const existing = await this.findCollectionAccount(input.reference);
      if (!existing) throw err;
      account = existing;
    }

    return {
      providerCheckoutId: account.accountReference ?? input.reference,
      providerChargeId: null,
      accountNumber: account.accountNumber,
      bankName: account.bankName ?? BANK78_BANK_NAME,
      accountName: account.accountName,
      totalKobo,
      // Bank78 doesn't echo the expiry; it is the one we asked for.
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
    };
  }

  private async findCollectionAccount(accountReference: string): Promise<VirtualNubanResult | null> {
    try {
      return await this.client.request<VirtualNubanResult>({
        method: 'GET',
        path: `/virtual-nuban/api/virtual-nubans/accountRef/${encodeURIComponent(accountReference)}`,
        op: 'collection.get',
        ref: accountReference,
      });
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) return null;
      throw err;
    }
  }

  /**
   * Bank78 has no "was this account paid" lookup: a reserved account reports
   * only whether it is active, and the credit itself is known only from the
   * webhook. So this never claims paid or expired — the webhook is the source
   * of truth for payment, and reconciliation expires a checkout on its own
   * clock once it is past due.
   */
  async getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus> {
    await this.findCollectionAccount(providerCheckoutId);
    return { state: 'open', receivedKobo: null };
  }

  async routeCollection(input: RouteCollectionInput): Promise<{ transferId: string | null }> {
    const res = await this.transfer({
      path: '/payout/send-money',
      op: 'collection.route',
      reference: input.reference,
      body: {
        accountNumber: input.accountId,
        amount: naira(input.amountKobo),
        narration: `Duevy collection ${input.reference}`,
        bankCode: BANK78_BANK_CODE,
        bankName: BANK78_BANK_NAME,
        reference: input.reference,
      },
    });
    if (res.state === 'failed') {
      throw new ProviderError(res.failureReason ?? 'Bank78 refused the transfer to the rep wallet', null, res.code, false);
    }
    return { transferId: res.providerPayoutId };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyBank78Signature(rawBody, headers, this.opts.webhookSecrets, this.opts.webhookToleranceSeconds);
    if (!check.ok) throw new InvalidSignatureError(`Webhook signature ${check.reason}`);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('Webhook body is not JSON');
    }
    return normaliseBank78Event(body, { clientSecret: this.opts.clientSecret });
  }

  // --- rep wallets -------------------------------------------------------------

  async createWallet(profile: WalletProfile): Promise<Wallet> {
    try {
      const account = await this.client.request<SubAccountResult>({
        method: 'POST',
        path: '/sub-account/api/v1/accounts',
        op: 'wallet.create',
        idempotencyKey: `wallet-${profile.userId}`,
        body: {
          userId: profile.userId,
          firstName: profile.firstName,
          lastName: profile.lastName,
          emailAddress: profile.email,
          phoneNumber: profile.phone,
          bvn: profile.bvn,
          ...(profile.nin ? { nin: profile.nin } : {}),
        },
      });
      return this.toWallet(account);
    } catch (err) {
      // "Duplicate Request": this user already has a wallet. Return it.
      if (!(err instanceof ProviderError) || err.retryable) throw err;
      const existing = await this.client
        .request<SubAccountResult>({
          method: 'GET',
          path: `/sub-account/api/v1/accounts/find-by-user-id/${encodeURIComponent(profile.userId)}`,
          op: 'wallet.find',
        })
        .catch(() => null);
      if (!existing) throw err;
      return this.toWallet(existing);
    }
  }

  async getWallet(accountId: string): Promise<Wallet> {
    const account = await this.client.request<SubAccountResult>({
      method: 'GET',
      path: `/sub-account/api/v1/accounts/balance/${encodeURIComponent(accountId)}`,
      op: 'wallet.get',
    });
    return this.toWallet(account);
  }

  private toWallet(a: SubAccountResult): Wallet {
    return {
      accountNumber: a.accountNumber,
      bankName: a.bankName ?? BANK78_BANK_NAME,
      active: a.isActive ?? true,
      availableKobo: kobo(a.availableBalance),
    };
  }

  // --- payouts -----------------------------------------------------------------

  async listBanks(): Promise<Bank[]> {
    const rows = await this.client.request<Record<string, unknown>[]>({ method: 'GET', path: '/payout/banks', op: 'banks.list' });
    return (Array.isArray(rows) ? rows : [])
      .map((b) => ({
        code: String(b.bankCode ?? b.code ?? b.institutionCode ?? ''),
        name: String(b.bankName ?? b.name ?? b.institutionName ?? ''),
      }))
      .filter((b) => b.code && b.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    try {
      const r = await this.client.request<{ accountName?: string | null }>({
        method: 'GET',
        path: `/payout/name-enquiry/${encodeURIComponent(accountNumber)}/${encodeURIComponent(bankCode)}`,
        op: 'name_enquiry',
      });
      return r?.accountName ? { accountName: r.accountName } : null;
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) return null;
      throw err;
    }
  }

  async registerPayoutDestination(input: RegisterDestinationInput): Promise<PayoutDestination> {
    const sealed: SealedDestination = {
      bankCode: input.bankCode,
      bankName: input.bankName,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
    };
    return { destinationId: encrypt(JSON.stringify(sealed)), usable: true, accountName: input.accountName };
  }

  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult> {
    let dest: SealedDestination;
    try {
      dest = JSON.parse(decrypt(input.destinationId)) as SealedDestination;
    } catch {
      throw new ProviderError('The payout destination could not be read', null, 'INVALID_DESTINATION', false);
    }
    const res = await this.transfer({
      path: '/payout/sub-account/send-money',
      op: 'payout.send',
      reference: input.reference,
      body: {
        sourceAccountNumber: input.accountId,
        accountNumber: dest.accountNumber,
        reference: input.reference,
        amount: naira(input.amountKobo),
        narration: `Duevy withdrawal ${input.reference}`,
        bankCode: dest.bankCode,
        bankName: dest.bankName,
      },
    });
    return { providerPayoutId: res.providerPayoutId, state: res.state, providerFeeKobo: res.feeKobo, failureReason: res.failureReason };
  }

  async getPayout(_accountId: string, providerPayoutId: string): Promise<PayoutResult> {
    const env = await this.client.call<TransferResult>({
      method: 'GET',
      path: `/payout/sub-account/query/${encodeURIComponent(providerPayoutId)}`,
      op: 'payout.get',
      ref: providerPayoutId,
    });
    const r = env.result ?? {};
    const state = payoutStateFromStatus(r.status) ?? payoutStateFromCode(env.responseCode ?? r.responseCode);
    return {
      providerPayoutId,
      state,
      providerFeeKobo: kobo(r.fee),
      failureReason: state === 'failed' ? r.message ?? env.message ?? null : null,
    };
  }

  /**
   * One outbound transfer. The response code — not the HTTP status — decides
   * the outcome; an unknown code stays processing. A definite refusal (4xx)
   * comes back as a ProviderError the caller can act on.
   */
  private async transfer(req: { path: string; op: string; reference: string; body: Record<string, unknown> }) {
    try {
      const env = await this.client.call<TransferResult>({
        method: 'POST',
        path: req.path,
        op: req.op,
        ref: req.reference,
        idempotencyKey: req.reference,
        body: req.body,
      });
      const r = env.result ?? {};
      const code = r.responseCode ?? env.responseCode ?? null;
      const state = payoutStateFromStatus(r.status) ?? payoutStateFromCode(code);
      logger.info({ op: req.op, ref: req.reference, state, code }, 'bank78 transfer accepted');
      return {
        providerPayoutId: r.reference ?? req.reference,
        state,
        code,
        feeKobo: kobo(r.fee),
        failureReason: state === 'failed' ? r.message ?? env.message ?? null : null,
      };
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable && /insufficient/i.test(err.message)) {
        throw new ProviderError(err.message, err.status, 'INSUFFICIENT_BALANCE', false);
      }
      throw err;
    }
  }
}

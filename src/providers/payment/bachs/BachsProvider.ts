import { createHash } from 'crypto';
import { decimalToKobo, koboToDecimal } from '../../../lib/money';
import { logger } from '../../../lib/logger';
import {
  InvalidSignatureError,
  ProviderError,
  type Bank,
  type CollectionAccount,
  type CollectionStatus,
  type CreateCollectionInput,
  type IdentityDocumentInput,
  type IdentityResult,
  type IdentityStatus,
  type InitiatePayoutInput,
  type PaymentProvider,
  type PayoutDestination,
  type PayoutResult,
  type PayoutState,
  type ProviderEvent,
  type RegisterDestinationInput,
  type ResolvedAccount,
  type SettleFeeInput,
  type VerifyIdentityInput,
} from '../types';
import { BachsClient } from './client';
import { normaliseBachsEvent } from './events';
import { verifyBachsSignature } from './signature';

/**
 * Bachs Connect as Duevy's payment rail.
 *
 * Shape of the integration (see docs/BACHS.md for the full reasoning):
 *  - Every rep is a recipient Connect account. KYC = the account's
 *    representative person, carrying the BVN.
 *  - Every checkout is a DESTINATION CHARGE created by the platform:
 *    gross = face + Duevy fee, platform_fee = Duevy fee, transfer_data.destination
 *    = the rep's account, which therefore receives exactly the face amount.
 *    Created with ui_mode "custom" so Bachs returns a one-time bank account for
 *    us to show instead of a hosted page. Card corridors are excluded.
 *  - Withdrawals are payouts made AS the rep's account (X-Account-Id).
 */

const BANK_TRANSFER = 'NGN_BANK_TRANSFER';

interface BachsCheckoutCreated {
  checkout_id: string;
  status?: string;
  amount?: string | number;
  checkout_url?: string | null;
  expires_at?: string;
}
interface BachsCheckoutPriced {
  amount?: string | number;
  base_amount?: string | number;
  processing_fee?: string | number;
}
interface BachsCheckoutConfirmed {
  checkout_id: string;
  charge_id?: string | null;
  next_step?: {
    type?: string;
    expires_at?: string;
    bank_account?: {
      account_name?: string;
      account_number?: string;
      bank_name?: string;
      expires_at?: string;
    };
  };
}
interface BachsCheckout {
  checkout_id: string;
  status?: string;
  payment_status?: string | null;
  amount?: string | number;
  charge?: { id?: string; status?: string; amount?: string | number } | null;
  expires_at?: string;
}
interface BachsAccount {
  id: string;
  capabilities?: Record<string, { status?: string } | undefined> | null;
  requirements?: {
    currently_due?: string[];
    past_due?: string[];
    pending_verification?: string[];
    errors?: unknown[];
  } | null;
  /** Field-level problems with a `fields` submission (POST /v1/accounts/{id}). */
  errors?: { field?: string; code?: string; message?: string }[] | null;
}
interface BachsPerson {
  id: string;
  relationship?: { representative?: boolean };
  verification?: { status?: string; failure_reason?: string | null };
}
interface BachsCapabilities {
  items?: { name: string; status?: string; requested?: boolean }[];
}
interface BachsPayout {
  id: string;
  status?: string;
  fee?: string | number | null;
  failure_reason?: string | null;
}
interface BachsDestination {
  id: string;
  is_usable?: boolean;
  account_name?: string | null;
}

function mapIdentityStatus(raw: string | undefined): IdentityStatus {
  // The guide says pending | passed | failed; the OpenAPI spec says
  // unverified | pending | verified | failed. Accept both.
  switch ((raw ?? '').toLowerCase()) {
    case 'passed':
    case 'verified':
      return 'verified';
    case 'failed':
      return 'rejected';
    default:
      return 'pending';
  }
}

/**
 * The rep's identity verdict. Bachs can approve an individual account without
 * ever moving the representative's own `verification.status` off
 * "unverified", so the person record alone can leave a rep pending forever.
 * An account with nothing outstanding and every requested capability active
 * has passed onboarding (docs.bachs.io/connect/guides/monitor-onboarding:
 * capability status, not empty requirements alone, is the signal).
 */
function identityVerdict(person: BachsPerson, account: BachsAccount, caps: BachsCapabilities): IdentityStatus {
  const fromPerson = mapIdentityStatus(person.verification?.status);
  if (fromPerson !== 'pending') return fromPerson;

  const r = account.requirements ?? {};
  const outstanding = [r.currently_due, r.past_due, r.pending_verification, r.errors].some((list) => (list?.length ?? 0) > 0);
  const requested = (caps.items ?? []).filter((c) => c.requested !== false);
  const allActive = requested.length > 0 && requested.every((c) => c.status === 'active');
  return !outstanding && allActive ? 'verified' : 'pending';
}

function mapPayoutState(raw: string | undefined): PayoutState {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
    case 'paid':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'processing':
      return 'processing';
    default:
      return 'pending';
  }
}

function optionalKobo(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  return decimalToKobo(v);
}

/** Stable, non-reversible key fragment — keeps account numbers out of idempotency keys. */
function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

export interface BachsProviderConfig {
  baseUrl: string;
  secretKey: string;
  webhookSecrets: string[];
  webhookToleranceSeconds: number;
}

export class BachsProvider implements PaymentProvider {
  readonly name = 'bachs';
  private readonly client: BachsClient;

  constructor(private readonly config: BachsProviderConfig) {
    this.client = new BachsClient(config.baseUrl, config.secretKey);
  }

  // -------------------------------------------------------------------------
  // Collections
  // -------------------------------------------------------------------------

  async createCollectionAccount(input: CreateCollectionInput): Promise<CollectionAccount> {
    return input.mode === 'hosted' ? this.createHostedCheckout(input) : this.createCustomCheckout(input);
  }

  /**
   * Hosted checkout: one call, then the student is redirected to Bachs's page.
   * Bachs sends them back to `returnUrl` either way; the collection.* webhook,
   * not the redirect, decides whether it was paid.
   */
  private async createHostedCheckout(input: CreateCollectionInput): Promise<CollectionAccount> {
    const ref = input.reference;
    const expectedTotal = input.faceKobo + input.platformFeeKobo;
    const created = await this.client.request<BachsCheckoutCreated>({
      method: 'POST',
      path: '/v1/checkout-sessions',
      op: 'checkout.create',
      ref,
      idempotencyKey: `chk-hosted-${ref}`,
      body: {
        pricing: { currency: 'NGN', base_currency: 'NGN', amount: koboToDecimal(expectedTotal) },
        platform_fee: koboToDecimal(input.platformFeeKobo),
        transfer_data: { destination: input.destinationAccountId },
        payment_method_types: [BANK_TRANSFER],
        customer: { email: input.customer.email, name: input.customer.name },
        reference: ref,
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
        expires_in_minutes: input.expiresInMinutes,
        metadata: input.metadata,
      },
    });
    if (!created.checkout_url) {
      throw new ProviderError('The payment provider did not return a checkout page', null, 'NO_CHECKOUT_URL', false);
    }
    const expiresAt =
      created.expires_at && !Number.isNaN(Date.parse(created.expires_at))
        ? new Date(created.expires_at)
        : new Date(Date.now() + input.expiresInMinutes * 60_000);

    return {
      providerCheckoutId: created.checkout_id,
      providerChargeId: null,
      accountNumber: null,
      bankName: null,
      accountName: null,
      checkoutUrl: created.checkout_url,
      totalKobo: optionalKobo(created.amount) ?? expectedTotal,
      expiresAt,
    };
  }

  /** Custom checkout: create, price for bank transfer, confirm → a one-time account we display. */
  private async createCustomCheckout(input: CreateCollectionInput): Promise<CollectionAccount> {
    const ref = input.reference;
    const expectedTotal = input.faceKobo + input.platformFeeKobo;

    // 1. Create the checkout as the PLATFORM, naming the rep as the destination.
    const created = await this.client.request<BachsCheckoutCreated>({
      method: 'POST',
      path: '/v1/checkout-sessions',
      op: 'checkout.create',
      ref,
      idempotencyKey: `chk-create-${ref}`,
      body: {
        ui_mode: 'custom',
        // The guide names this base_currency, the OpenAPI spec currency.
        pricing: { currency: 'NGN', base_currency: 'NGN', amount: koboToDecimal(expectedTotal) },
        platform_fee: koboToDecimal(input.platformFeeKobo),
        transfer_data: { destination: input.destinationAccountId },
        payment_method_types: [BANK_TRANSFER],
        customer: { email: input.customer.email, name: input.customer.name },
        reference: ref,
        expires_in_minutes: input.expiresInMinutes,
        metadata: input.metadata,
      },
    });

    // 2. Price it for bank transfer. This is where Bachs would add its own fee
    //    if the customer bore it; Duevy's checkout settings make the merchant
    //    absorb it, so the price must equal what we computed.
    const priced = await this.client.request<BachsCheckoutPriced>({
      method: 'PATCH',
      path: `/v1/checkout-sessions/${encodeURIComponent(created.checkout_id)}`,
      op: 'checkout.price',
      ref,
      idempotencyKey: `chk-price-${ref}`,
      body: { payment_method: BANK_TRANSFER, currency: 'NGN' },
    });
    const pricedTotal = optionalKobo(priced.amount) ?? expectedTotal;
    if (pricedTotal !== expectedTotal) {
      logger.error({ ref, expectedTotal, pricedTotal }, 'bachs priced the checkout differently from our fee policy');
      throw new ProviderError(
        'The payment provider quoted a different total than Duevy computed. Check that the processing fee is absorbed by the merchant.',
        null,
        'PRICE_MISMATCH',
        false,
      );
    }

    // 3. Confirm: this opens the one-time bank account.
    const confirmed = await this.client.request<BachsCheckoutConfirmed>({
      method: 'POST',
      path: `/v1/checkout-sessions/${encodeURIComponent(created.checkout_id)}/confirm`,
      op: 'checkout.confirm',
      ref,
      idempotencyKey: `chk-confirm-${ref}`,
      body: {},
    });

    const bank = confirmed.next_step?.bank_account;
    if (!bank?.account_number) {
      throw new ProviderError('The payment provider did not return a bank account to pay into', null, 'NO_BANK_ACCOUNT', false);
    }
    const expiresRaw = bank.expires_at ?? confirmed.next_step?.expires_at;
    const expiresAt =
      expiresRaw && !Number.isNaN(Date.parse(expiresRaw))
        ? new Date(expiresRaw)
        : new Date(Date.now() + input.expiresInMinutes * 60_000);

    return {
      providerCheckoutId: created.checkout_id,
      providerChargeId: confirmed.charge_id ?? null,
      accountNumber: bank.account_number,
      bankName: bank.bank_name ?? '',
      accountName: bank.account_name ?? '',
      checkoutUrl: null,
      totalKobo: pricedTotal,
      expiresAt,
    };
  }

  async getCollectionStatus(providerCheckoutId: string): Promise<CollectionStatus> {
    const c = await this.client.request<BachsCheckout>({
      method: 'GET',
      path: `/v1/checkout-sessions/${encodeURIComponent(providerCheckoutId)}`,
      op: 'checkout.get',
    });
    const payment = (c.payment_status ?? '').toLowerCase();
    const charge = (c.charge?.status ?? '').toLowerCase();
    const status = (c.status ?? '').toLowerCase();
    const gross = optionalKobo(c.charge?.amount ?? c.amount);

    if (['succeeded', 'paid', 'accepted', 'overpaid'].includes(payment) || ['succeeded', 'accepted', 'overpaid'].includes(charge)) {
      return { state: 'paid', receivedKobo: gross };
    }
    if (charge === 'underpaid' || payment === 'underpaid') return { state: 'underpaid', receivedKobo: null };
    if (status === 'expired') return { state: 'expired', receivedKobo: null };
    if (payment === 'failed' || payment === 'canceled' || charge === 'failed') return { state: 'failed', receivedKobo: null };
    return { state: 'open', receivedKobo: null };
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  async verifyIdentity(input: VerifyIdentityInput): Promise<IdentityResult> {
    const { profile } = input;
    const accountId = input.existingAccountId ?? (await this.createRepAccount(input));

    const personBody = {
      first_name: profile.firstName,
      last_name: profile.lastName,
      dob: input.dob,
      email: profile.email,
      ...(profile.phone ? { phone: profile.phone } : {}),
      relationship: { representative: true },
      // Typed identifiers. A NIN satisfies the id_number requirement on its
      // own; a BVN, if Bachs later asks, sits beside it in the same list.
      id_numbers: input.idNumbers.map((n) => ({ type: n.type, value: n.value, issuing_country: 'NG' })),
    };

    // Re-use the representative if one exists (a retry, or a create that timed
    // out after Bachs had already stored it) rather than adding a second person.
    let personId = input.existingPersonId ?? (await this.findRepresentative(accountId));
    if (personId) {
      await this.client.request<BachsPerson>({
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(accountId)}/persons/${encodeURIComponent(personId)}`,
        op: 'person.update',
        body: personBody,
      });
    } else {
      const person = await this.client.request<BachsPerson>({
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(accountId)}/persons`,
        op: 'person.create',
        body: personBody,
      });
      personId = person.id;
    }

    return this.getIdentityStatus(accountId, personId);
  }

  private async createRepAccount(input: VerifyIdentityInput): Promise<string> {
    const { profile } = input;
    const account = await this.client.request<BachsAccount>({
      method: 'POST',
      path: '/v1/accounts',
      op: 'account.create',
      idempotencyKey: `acct-${profile.userId}`,
      body: {
        contact_email: profile.email,
        display_name: profile.displayName,
        first_name: profile.firstName,
        last_name: profile.lastName,
        country: 'NG',
        entity_type: 'individual',
        // Recipient only: the account receives destination-charge shares and
        // pays out. It never accepts payments in its own name.
        configuration: {
          recipient: { capabilities: { transfers: { requested: true }, payouts: { requested: true } } },
        },
      },
    });
    return account.id;
  }

  private async findRepresentative(accountId: string): Promise<string | null> {
    const list = await this.client.request<{ items?: BachsPerson[] }>({
      method: 'GET',
      path: `/v1/accounts/${encodeURIComponent(accountId)}/persons`,
      op: 'person.list',
    });
    return list.items?.find((p) => p.relationship?.representative)?.id ?? null;
  }

  async getIdentityStatus(accountId: string, personId: string): Promise<IdentityResult> {
    const [person, caps, account] = await Promise.all([
      this.client.request<BachsPerson>({
        method: 'GET',
        path: `/v1/accounts/${encodeURIComponent(accountId)}/persons/${encodeURIComponent(personId)}`,
        op: 'person.get',
      }),
      this.client.request<BachsCapabilities>({
        method: 'GET',
        path: `/v1/accounts/${encodeURIComponent(accountId)}/capabilities`,
        op: 'account.capabilities',
      }),
      this.client.request<BachsAccount>({
        method: 'GET',
        path: `/v1/accounts/${encodeURIComponent(accountId)}`,
        op: 'account.get',
      }),
    ]);
    const due = [...(account.requirements?.past_due ?? []), ...(account.requirements?.currently_due ?? [])];
    const payouts = caps.items?.find((c) => c.name === 'payouts');
    return {
      accountId,
      personId,
      status: identityVerdict(person, account, caps),
      payoutsActive: payouts?.status === 'active',
      failureReason: person.verification?.failure_reason ?? null,
      requirementsDue: [...new Set(due)],
    };
  }

  /**
   * Bachs takes documents as a file upload first, then a reference to it:
   * POST /v1/utilities/uploads (scope identity_document), then attach to the
   * person's primary_verification slot.
   */
  async uploadIdentityDocument(input: IdentityDocumentInput): Promise<{ documentId: string }> {
    const form = new FormData();
    form.append('scope', 'identity_document');
    form.append('file', new Blob([input.buffer], { type: input.mimeType }), input.fileName);
    const upload = await this.client.request<{ upload_id: string }>({
      method: 'POST',
      path: '/v1/utilities/uploads',
      op: 'upload.identity_document',
      body: form,
    });
    const doc = await this.client.request<{ id: string }>({
      method: 'POST',
      path: `/v1/accounts/${encodeURIComponent(input.accountId)}/persons/${encodeURIComponent(input.personId)}/documents`,
      op: 'person.document.attach',
      body: { file: upload.upload_id, document: 'primary_verification', side: 'front' },
    });
    return { documentId: doc.id };
  }

  // -------------------------------------------------------------------------
  // Banks, payouts
  // -------------------------------------------------------------------------

  async listBanks(): Promise<Bank[]> {
    const res = await this.client.request<{ banks?: { name: string; code: string }[] }>({
      method: 'GET',
      path: '/v1/reference/banks',
      query: { country: 'NG' },
      op: 'banks.list',
    });
    return (res.banks ?? []).map((b) => ({ code: b.code, name: b.name }));
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount | null> {
    const res = await this.client.request<{ resolved?: boolean; account_name?: string | null }>({
      method: 'POST',
      path: '/v1/misc/bank-accounts/resolve',
      op: 'bank.resolve',
      body: { account_number: accountNumber, bank_code: bankCode, country: 'NG' },
    });
    // "A false here is not an HTTP error" — an unresolvable account is a 200.
    return res.resolved && res.account_name ? { accountName: res.account_name } : null;
  }

  async registerPayoutDestination(input: RegisterDestinationInput): Promise<PayoutDestination> {
    const d = await this.client.request<BachsDestination>({
      method: 'POST',
      path: '/v1/payouts/destinations',
      op: 'destination.create',
      accountId: input.accountId,
      idempotencyKey: `dest-${digest(input.accountId, input.bankCode, input.accountNumber)}`,
      body: {
        currency: 'NGN',
        type: 'bank_account',
        account_number: input.accountNumber,
        bank_code: input.bankCode,
        account_name: input.accountName,
      },
    });
    return { destinationId: d.id, usable: d.is_usable ?? false, accountName: d.account_name ?? null };
  }

  async submitAccountPayoutDestination(input: RegisterDestinationInput): Promise<void> {
    // docs.bachs.io/connect/requirements#the-payout-destination-shape
    const account = await this.client.request<BachsAccount>({
      method: 'POST',
      path: `/v1/accounts/${encodeURIComponent(input.accountId)}`,
      op: 'account.payout_destination',
      idempotencyKey: `acct-dest-${digest(input.accountId, input.bankCode, input.accountNumber)}`,
      body: {
        fields: {
          payout_destination: {
            type: 'bank_account',
            currency: 'NGN',
            account_number: input.accountNumber,
            account_name: input.accountName,
            bank_code: input.bankCode,
          },
        },
      },
    });
    // A refused field comes back in errors[] on a 200; `required` only means incomplete.
    const refused = (account.errors ?? []).find((e) => e.field?.startsWith('payout_destination') && e.code !== 'required');
    if (refused) {
      throw new ProviderError(
        refused.message ?? 'The payment provider refused this bank account',
        422,
        'PAYOUT_DESTINATION_REJECTED',
        false,
      );
    }
  }

  async initiatePayout(input: InitiatePayoutInput): Promise<PayoutResult> {
    const p = await this.client.request<BachsPayout>({
      method: 'POST',
      path: '/v1/payouts',
      op: 'payout.create',
      ref: input.reference,
      accountId: input.accountId,
      // The reference IS the idempotency key: retrying after a timeout replays
      // the first response rather than paying twice.
      idempotencyKey: input.reference,
      body: { destination: input.destinationId, amount: koboToDecimal(input.amountKobo), reference: input.reference },
    });
    return {
      providerPayoutId: p.id,
      state: mapPayoutState(p.status),
      providerFeeKobo: optionalKobo(p.fee),
      failureReason: p.failure_reason ?? null,
    };
  }

  async getPayout(accountId: string, providerPayoutId: string): Promise<PayoutResult> {
    const p = await this.client.request<BachsPayout>({
      method: 'GET',
      path: `/v1/payouts/${encodeURIComponent(providerPayoutId)}`,
      op: 'payout.get',
      accountId,
    });
    return {
      providerPayoutId: p.id,
      state: mapPayoutState(p.status),
      providerFeeKobo: optionalKobo(p.fee),
      failureReason: p.failure_reason ?? null,
    };
  }

  async settleFee(input: SettleFeeInput): Promise<{ transferId: string }> {
    if (input.amountKobo === 0) return { transferId: 'none' };
    const toPlatform = input.amountKobo > 0;
    const t = await this.client.request<{ id: string }>({
      method: 'POST',
      path: '/v1/transfers',
      op: toPlatform ? 'fee.sweep' : 'fee.topup',
      ref: input.reference,
      // Sweeping: act AS the rep's account and send to "self" (the platform).
      // Topping up: act as the platform and send to the rep's account.
      accountId: toPlatform ? input.accountId : null,
      idempotencyKey: `fee-${input.reference}`,
      body: {
        destination: toPlatform ? 'self' : input.accountId,
        amount: koboToDecimal(Math.abs(input.amountKobo)),
        currency: 'NGN',
        description: `Duevy withdrawal fee ${input.reference}`,
        transfer_group: input.reference,
      },
    });
    return { transferId: t.id };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const check = verifyBachsSignature(rawBody, headers, this.config.webhookSecrets, this.config.webhookToleranceSeconds);
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

import { env } from '../config/env';
import type {
  InitTransactionInput,
  InitTransactionResult,
  MonnifyTxnStatus,
  MonnifyBank,
  MonnifyCardDetails,
  ChargeCardInput,
  ChargeCardResult,
  DisbursementInput,
  DisbursementResult,
  CreateSubaccountInput,
  SubaccountResult,
  BankTransferChargeInput,
  BankTransferChargeResult,
  RefundInput,
  RefundResult,
} from './monnify';

/**
 * Paystack API client, shaped to match src/lib/monnify.ts's exported surface
 * function-for-function so src/lib/paymentGateway.ts can switch between the
 * two with no call-site changes. Unlike Monnify, Paystack needs no login
 * handshake — every call is Bearer-authed with the static secret key, and
 * amounts are already in kobo (no naira conversion needed).
 */

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data?: T;
}

async function paystackFetch<T>(path: string, init?: RequestInit): Promise<PaystackResponse<T>> {
  const res = await fetch(`${env.PAYSTACK_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const json = (await res.json()) as PaystackResponse<T>;
  if (!res.ok || !json.status) {
    console.error(`[paystack] ${path} failed:`, JSON.stringify(json));
  }
  return json;
}

/** Initialise a hosted-checkout transaction; returns the URL to redirect the payer to. */
export async function initTransaction(input: InitTransactionInput): Promise<InitTransactionResult> {
  const json = await paystackFetch<{ authorization_url: string; access_code: string; reference: string }>(
    '/transaction/initialize',
    {
      method: 'POST',
      body: JSON.stringify({
        email: input.customerEmail,
        amount: input.amount, // Paystack takes kobo directly
        reference: input.reference,
        callback_url: `${env.FRONTEND_URL}${input.callbackPath}`,
        metadata: { customerName: input.customerName, description: input.description },
      }),
    },
  );
  if (!json.status || !json.data) {
    throw new Error(`Paystack init failed: ${json.message}`);
  }
  return {
    checkoutUrl: json.data.authorization_url,
    transactionReference: json.data.reference,
    paymentReference: json.data.reference,
  };
}

interface PaystackAuthorization {
  authorization_code: string;
  card_type: string;
  last4: string;
  exp_month: string;
  exp_year: string;
}

interface PaystackVerifyData {
  status: 'success' | 'failed' | 'abandoned';
  reference: string;
  amount: number; // kobo
  authorization?: PaystackAuthorization;
}

/** Read a transaction's status (used by §6.4 polling and the reconciliation job). */
export async function getTransactionStatus(reference: string): Promise<MonnifyTxnStatus | null> {
  const json = await paystackFetch<PaystackVerifyData>(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!json.status || !json.data) return null;

  const status = json.data.status === 'success' ? 'PAID' : json.data.status === 'abandoned' ? 'PENDING' : 'FAILED';
  return {
    paymentStatus: status,
    amountPaid: json.data.amount,
    paymentReference: json.data.reference,
    transactionReference: json.data.reference,
  };
}

/** Resolve a NUBAN to its account name (§10.2). Returns null if unverifiable. */
export async function verifyAccountName(accountNumber: string, bankCode: string): Promise<string | null> {
  try {
    const json = await paystackFetch<{ account_number: string; account_name: string }>(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    return json.status && json.data ? json.data.account_name : null;
  } catch {
    return null;
  }
}

interface BanksCache {
  banks: MonnifyBank[];
  expiresAt: number;
}

let cachedBanks: BanksCache | null = null;
const BANKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** List the banks Paystack supports for transfers/name-enquiry (§10.2). Cached for 24h. */
export async function getBanks(): Promise<MonnifyBank[]> {
  if (cachedBanks && cachedBanks.expiresAt > Date.now()) {
    return cachedBanks.banks;
  }

  const json = await paystackFetch<Array<{ name: string; code: string }>>('/bank?currency=NGN&perPage=100');
  if (!json.status || !json.data) {
    throw new Error(`Paystack bank list failed: ${json.message}`);
  }

  const banks = json.data.map((b) => ({ code: b.code, name: b.name }));
  cachedBanks = { banks, expiresAt: Date.now() + BANKS_CACHE_TTL_MS };
  return banks;
}

/**
 * Fetch the tokenized card behind a completed charge — Paystack returns the
 * reusable `authorization_code` on the same verify call used for status
 * checks (§8.4 card-save flow), no separate endpoint needed.
 */
export async function getCardDetails(transactionReference: string): Promise<MonnifyCardDetails | null> {
  const json = await paystackFetch<PaystackVerifyData>(`/transaction/verify/${encodeURIComponent(transactionReference)}`);
  const auth = json.data?.authorization;
  if (!json.status || !auth) return null;

  return {
    cardType: auth.card_type,
    last4: auth.last4,
    expMonth: auth.exp_month,
    expYear: auth.exp_year,
    cardToken: auth.authorization_code,
  };
}

/**
 * Charge a previously tokenized card via Paystack's charge_authorization (§8.4).
 * When `input.subaccount` is set (payment architecture migration — reps settle
 * directly instead of via manual payout), the split is passed straight through.
 * UNVERIFIED — confirm `subaccount`/`transaction_charge`/`bearer` field names
 * and semantics against Paystack's live docs before relying on this in prod;
 * see computeSubaccountSplit() in src/lib/money.ts for the same caveat.
 */
export async function chargeCardToken(input: ChargeCardInput): Promise<ChargeCardResult> {
  const json = await paystackFetch<{ status?: string; reference?: string }>('/transaction/charge_authorization', {
    method: 'POST',
    body: JSON.stringify({
      authorization_code: input.cardToken,
      email: input.customerEmail,
      amount: input.amount,
      reference: input.reference,
      ...(input.subaccount
        ? {
            subaccount: input.subaccount.code,
            transaction_charge: input.amount - input.subaccount.shareKobo,
            bearer: input.subaccount.bearer,
          }
        : {}),
    }),
  });

  return {
    paid: json.data?.status === 'success',
    transactionReference: json.data?.reference ?? input.reference,
    responseMessage: json.message ?? '',
  };
}

function mapTransferStatus(raw: string | undefined): DisbursementResult['status'] {
  if (raw === 'success') return 'SUCCESS';
  if (raw === 'failed' || raw === 'reversed') return 'FAILED';
  return 'PENDING'; // includes 'pending' and 'otp' — an OTP-gated transfer can't resolve automatically
}

/**
 * Initiate a single bank transfer for a rep payout (§10.3). Paystack requires
 * a transfer recipient to exist before a transfer can be sent, so this creates
 * one on the fly — Paystack dedupes identical recipients internally.
 */
export async function initiateDisbursement(input: DisbursementInput): Promise<DisbursementResult> {
  const recipient = await paystackFetch<{ recipient_code: string }>('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify({
      type: 'nuban',
      name: input.accountName,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: 'NGN',
    }),
  });
  if (!recipient.status || !recipient.data) {
    throw new Error(`Paystack transfer-recipient failed: ${recipient.message}`);
  }

  const transfer = await paystackFetch<{ status?: string; transfer_code?: string }>('/transfer', {
    method: 'POST',
    body: JSON.stringify({
      source: 'balance',
      amount: input.amount,
      recipient: recipient.data.recipient_code,
      reference: input.reference,
      reason: input.narration,
    }),
  });
  if (!transfer.status) {
    throw new Error(`Paystack disbursement failed: ${transfer.message}`);
  }

  return { status: mapTransferStatus(transfer.data?.status), reference: input.reference };
}

/** Poll the status of a previously initiated disbursement (reconciliation job). */
export async function getDisbursementStatus(reference: string): Promise<DisbursementResult | null> {
  const json = await paystackFetch<{ status?: string }>(`/transfer/verify/${encodeURIComponent(reference)}`);
  if (!json.status || !json.data) return null;
  return { status: mapTransferStatus(json.data.status), reference };
}

// ---------------------------------------------------------------------------
// Subaccounts (payment architecture migration) — a rep's space settles
// directly into one of these at charge time instead of via manual payout.
// UNVERIFIED — confirm exact field names (business_name/settlement_bank/
// account_number/percentage_charge are best recollection, not confirmed)
// against Paystack's live API docs before relying on this in prod.
// ---------------------------------------------------------------------------

export async function createSubaccount(input: CreateSubaccountInput): Promise<SubaccountResult> {
  const json = await paystackFetch<{ subaccount_code?: string }>('/subaccount', {
    method: 'POST',
    body: JSON.stringify({
      business_name: input.businessName,
      settlement_bank: input.bankCode,
      account_number: input.accountNumber,
      percentage_charge: input.percentageCharge,
    }),
  });
  if (!json.status || !json.data?.subaccount_code) {
    throw new Error(`Paystack subaccount creation failed: ${json.message}`);
  }
  return { subaccountCode: json.data.subaccount_code };
}

export async function updateSubaccount(
  subaccountCode: string,
  input: Partial<CreateSubaccountInput>,
): Promise<SubaccountResult> {
  const json = await paystackFetch<{ subaccount_code?: string }>(`/subaccount/${encodeURIComponent(subaccountCode)}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...(input.businessName ? { business_name: input.businessName } : {}),
      ...(input.bankCode ? { settlement_bank: input.bankCode } : {}),
      ...(input.accountNumber ? { account_number: input.accountNumber } : {}),
      ...(input.percentageCharge !== undefined ? { percentage_charge: input.percentageCharge } : {}),
    }),
  });
  if (!json.status) {
    throw new Error(`Paystack subaccount update failed: ${json.message}`);
  }
  return { subaccountCode: json.data?.subaccount_code ?? subaccountCode };
}

/**
 * In-app "invoice" flow (payment architecture migration) — forces Paystack's
 * Charge API onto the bank_transfer channel so the payer sees a dedicated
 * virtual account inline instead of being redirected to a hosted page.
 * UNVERIFIED — confirm against Paystack's live docs before relying on this in
 * prod: exact request shape for forcing the bank_transfer channel, exact
 * response field names/nesting for the returned virtual account, and whether
 * this is a genuine one-time NUBAN per charge or a persistent DVA needing
 * separate charge-matching logic.
 */
export async function createBankTransferCharge(input: BankTransferChargeInput): Promise<BankTransferChargeResult> {
  const json = await paystackFetch<{
    reference?: string;
    bank_transfer?: {
      account_number?: string;
      account_name?: string;
      bank_name?: string;
      account_expires_at?: string;
    };
  }>('/charge', {
    method: 'POST',
    body: JSON.stringify({
      email: input.customerEmail,
      amount: input.amount,
      reference: input.reference,
      bank_transfer: {},
      ...(input.subaccountCode
        ? {
            subaccount: input.subaccountCode,
            transaction_charge: input.subaccountShareKobo !== undefined ? input.amount - input.subaccountShareKobo : undefined,
            bearer: 'account',
          }
        : {}),
    }),
  });
  if (!json.status || !json.data?.bank_transfer?.account_number) {
    throw new Error(`Paystack bank-transfer charge failed: ${json.message}`);
  }

  const bt = json.data.bank_transfer;
  return {
    reference: json.data.reference ?? input.reference,
    bankTransfer: {
      accountNumber: bt.account_number as string,
      bankName: bt.bank_name ?? '',
      accountName: bt.account_name ?? '',
      expiresAt: bt.account_expires_at ?? null,
    },
  };
}

/**
 * Reverse a transaction via Paystack's refund API, returning money to the
 * payer's original source (card/bank) rather than an internal wallet credit.
 * UNVERIFIED — confirm against Paystack's live docs before relying on this in
 * prod: exact request shape (is `transaction` the reference string or a
 * numeric Paystack transaction ID?), whether partial refunds by kobo amount
 * are supported, and whether refunds confirm synchronously or asynchronously
 * via a `refund.processed` webhook event (would need a new webhooks.ts
 * branch if so — none exists yet). Also unverified: whether refunding a
 * subaccount-split payment automatically claws back the rep's settled share,
 * or whether that needs a separate reversal — check before this ships for
 * real money.
 */
export async function refundTransaction(input: RefundInput): Promise<RefundResult> {
  const json = await paystackFetch<{ status?: string }>('/refund', {
    method: 'POST',
    body: JSON.stringify({
      transaction: input.reference,
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
    }),
  });
  if (!json.status) {
    throw new Error(`Paystack refund failed: ${json.message}`);
  }
  const raw = json.data?.status;
  const status: RefundResult['status'] = raw === 'processed' ? 'processed' : raw === 'failed' ? 'failed' : 'pending';
  return { status };
}

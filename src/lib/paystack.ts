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

/** Charge a previously tokenized card via Paystack's charge_authorization (§8.4). */
export async function chargeCardToken(input: ChargeCardInput): Promise<ChargeCardResult> {
  const json = await paystackFetch<{ status?: string; reference?: string }>('/transaction/charge_authorization', {
    method: 'POST',
    body: JSON.stringify({
      authorization_code: input.cardToken,
      email: input.customerEmail,
      amount: input.amount,
      reference: input.reference,
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

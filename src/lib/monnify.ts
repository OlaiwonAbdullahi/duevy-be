import { env } from "../config/env";

/**
 * Minimal Monnify API client. Handles the Basic-auth login handshake (caching
 * the bearer token until shortly before it expires) and the two calls we need:
 * initialising a hosted-checkout transaction and reading a transaction's status.
 */

interface MonnifyToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: MonnifyToken | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(
    `${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`,
  ).toString("base64");
  const res = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  const json = (await res.json()) as {
    requestSuccessful: boolean;
    responseBody?: { accessToken: string; expiresIn: number };
    responseMessage?: string;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) {
    throw new Error(
      `Monnify auth failed: ${json.responseMessage ?? res.status}`,
    );
  }

  cachedToken = {
    accessToken: json.responseBody.accessToken,
    expiresAt: Date.now() + json.responseBody.expiresIn * 1000,
  };
  return cachedToken.accessToken;
}

export interface InitTransactionInput {
  amount: number;
  reference: string;
  customerName: string;
  customerEmail: string;
  description: string;
}

export interface InitTransactionResult {
  checkoutUrl: string;
  transactionReference: string;
  paymentReference: string;
}

/** Initialise a hosted-checkout transaction; returns the URL to redirect the payer to. */
export async function initTransaction(
  input: InitTransactionInput,
): Promise<InitTransactionResult> {
  const token = await getAccessToken();
  const res = await fetch(
    `${env.MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Monnify expects the major unit (naira), not kobo.
        amount: input.amount / 100,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        paymentReference: input.reference,
        paymentDescription: input.description,
        currencyCode: "NGN",
        contractCode: env.MONNIFY_CONTRACT_CODE,
        redirectUrl: `${env.FRONTEND_URL}/wallet`,
        paymentMethods: ["CARD", "ACCOUNT_TRANSFER"],
      }),
    },
  );
  const json = (await res.json()) as {
    requestSuccessful: boolean;
    responseBody?: {
      checkoutUrl: string;
      transactionReference: string;
      paymentReference: string;
    };
    responseMessage?: string;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) {
    throw new Error(
      `Monnify init failed: ${json.responseMessage ?? res.status}`,
    );
  }
  return json.responseBody;
}

export interface MonnifyTxnStatus {
  paymentStatus: string; // PAID | PENDING | FAILED | ...
  amountPaid: number; // naira
  paymentReference: string;
  transactionReference: string;
}

/**
 * Best-effort NUBAN name-enquiry (§10.2). Returns the resolved account name, or
 * null if the disbursement product isn't enabled / the account can't be verified
 * — callers fall back to a client-supplied name in that case.
 */
export async function verifyAccountName(
  accountNumber: string,
  bankCode: string,
): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const url = `${env.MONNIFY_BASE_URL}/api/v1/disbursements/account/validate?accountNumber=${encodeURIComponent(
      accountNumber,
    )}&bankCode=${encodeURIComponent(bankCode)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as {
      requestSuccessful?: boolean;
      responseBody?: { accountName?: string };
    };
    if (!res.ok || !json.requestSuccessful || !json.responseBody?.accountName)
      return null;
    return json.responseBody.accountName;
  } catch {
    return null;
  }
}

/** Read a transaction's status (used by §6.4 polling and the reconciliation job). */
export async function getTransactionStatus(
  transactionReference: string,
): Promise<MonnifyTxnStatus | null> {
  const token = await getAccessToken();
  const url = `${env.MONNIFY_BASE_URL}/api/v2/transactions/${encodeURIComponent(transactionReference)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as {
    requestSuccessful: boolean;
    responseBody?: MonnifyTxnStatus;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) return null;
  return json.responseBody;
}

export interface ChargeCardInput {
  amount: number; // kobo
  reference: string;
  customerName: string;
  customerEmail: string;
  description: string;
  cardToken: string;
}

export interface ChargeCardResult {
  paid: boolean;
  transactionReference: string;
  responseMessage: string;
}

/**
 * Charge a previously tokenized card (§8.4). Cards are tokenized once via the
 * PSP's inline SDK; subsequent charges use the stored token so PANs never
 * touch this API again. Charges that come back needing further authorization
 * (OTP/3DS) are treated as declined here — the recurring-token flow assumes
 * a non-interactive charge, matching how saved cards are meant to be used.
 */
export async function chargeCardToken(input: ChargeCardInput): Promise<ChargeCardResult> {
  const token = await getAccessToken();
  const res = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/merchant/cards/charge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transactionReference: input.reference,
      cardToken: input.cardToken,
      amount: input.amount / 100,
      customerFullName: input.customerName,
      customerEmail: input.customerEmail,
      paymentDescription: input.description,
      currencyCode: 'NGN',
      contractCode: env.MONNIFY_CONTRACT_CODE,
      apiKey: env.MONNIFY_API_KEY,
    }),
  });
  const json = (await res.json()) as {
    requestSuccessful?: boolean;
    responseBody?: { paymentStatus?: string; transactionReference?: string };
    responseMessage?: string;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) {
    return {
      paid: false,
      transactionReference: input.reference,
      responseMessage: json.responseMessage ?? `Card charge failed (${res.status})`,
    };
  }
  return {
    paid: json.responseBody.paymentStatus === 'PAID',
    transactionReference: json.responseBody.transactionReference ?? input.reference,
    responseMessage: json.responseMessage ?? '',
  };
}

export interface DisbursementInput {
  amount: number; // kobo
  reference: string;
  narration: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

export interface DisbursementResult {
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  reference: string;
}

/** Initiate a single bank transfer for a rep payout (§10.3). */
export async function initiateDisbursement(input: DisbursementInput): Promise<DisbursementResult> {
  if (!env.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT) {
    throw new Error('MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT is not configured');
  }
  const token = await getAccessToken();
  const res = await fetch(`${env.MONNIFY_BASE_URL}/api/v2/disbursements/single`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: input.amount / 100,
      reference: input.reference,
      narration: input.narration,
      destinationBankCode: input.bankCode,
      destinationAccountNumber: input.accountNumber,
      destinationAccountName: input.accountName,
      currency: 'NGN',
      sourceAccountNumber: env.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT,
      async: true,
    }),
  });
  const json = (await res.json()) as {
    requestSuccessful?: boolean;
    responseBody?: { status?: string };
    responseMessage?: string;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody?.status) {
    throw new Error(`Monnify disbursement failed: ${json.responseMessage ?? res.status}`);
  }
  const raw = json.responseBody.status;
  const status: DisbursementResult['status'] =
    raw === 'SUCCESS' ? 'SUCCESS' : raw === 'FAILED' || raw === 'REVERSED' ? 'FAILED' : 'PENDING';
  return { status, reference: input.reference };
}

/** Poll the status of a previously initiated disbursement (reconciliation job). */
export async function getDisbursementStatus(reference: string): Promise<DisbursementResult | null> {
  const token = await getAccessToken();
  const url = `${env.MONNIFY_BASE_URL}/api/v2/disbursements/single/summary?reference=${encodeURIComponent(reference)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as {
    requestSuccessful?: boolean;
    responseBody?: { status?: string };
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody?.status) return null;
  const raw = json.responseBody.status;
  const status: DisbursementResult['status'] =
    raw === 'SUCCESS' ? 'SUCCESS' : raw === 'FAILED' || raw === 'REVERSED' ? 'FAILED' : 'PENDING';
  return { status, reference };
}

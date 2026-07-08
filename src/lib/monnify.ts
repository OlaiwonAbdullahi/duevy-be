import { env } from '../config/env';

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

  const basic = Buffer.from(`${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`).toString('base64');
  const res = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const json = (await res.json()) as {
    requestSuccessful: boolean;
    responseBody?: { accessToken: string; expiresIn: number };
    responseMessage?: string;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) {
    throw new Error(`Monnify auth failed: ${json.responseMessage ?? res.status}`);
  }

  cachedToken = {
    accessToken: json.responseBody.accessToken,
    expiresAt: Date.now() + json.responseBody.expiresIn * 1000,
  };
  return cachedToken.accessToken;
}

export interface InitTransactionInput {
  amount: number; // kobo
  reference: string; // our paymentReference
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
export async function initTransaction(input: InitTransactionInput): Promise<InitTransactionResult> {
  const token = await getAccessToken();
  const res = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Monnify expects the major unit (naira), not kobo.
      amount: input.amount / 100,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      paymentReference: input.reference,
      paymentDescription: input.description,
      currencyCode: 'NGN',
      contractCode: env.MONNIFY_CONTRACT_CODE,
      redirectUrl: `${env.FRONTEND_URL}/wallet`,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER'],
    }),
  });
  const json = (await res.json()) as {
    requestSuccessful: boolean;
    responseBody?: { checkoutUrl: string; transactionReference: string; paymentReference: string };
    responseMessage?: string;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) {
    throw new Error(`Monnify init failed: ${json.responseMessage ?? res.status}`);
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
export async function verifyAccountName(accountNumber: string, bankCode: string): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const url = `${env.MONNIFY_BASE_URL}/api/v1/disbursements/account/validate?accountNumber=${encodeURIComponent(
      accountNumber,
    )}&bankCode=${encodeURIComponent(bankCode)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { requestSuccessful?: boolean; responseBody?: { accountName?: string } };
    if (!res.ok || !json.requestSuccessful || !json.responseBody?.accountName) return null;
    return json.responseBody.accountName;
  } catch {
    return null;
  }
}

/** Read a transaction's status (used by §6.4 polling and the reconciliation job). */
export async function getTransactionStatus(transactionReference: string): Promise<MonnifyTxnStatus | null> {
  const token = await getAccessToken();
  const url = `${env.MONNIFY_BASE_URL}/api/v2/transactions/${encodeURIComponent(transactionReference)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as {
    requestSuccessful: boolean;
    responseBody?: MonnifyTxnStatus;
  };
  if (!res.ok || !json.requestSuccessful || !json.responseBody) return null;
  return json.responseBody;
}

import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/**
 * Anchor (getanchor.co) API client — the sole payment processor, replacing
 * Bachs Connect. Anchor is a BaaS rather than a gateway: there is no hosted
 * checkout, and every object (customer, deposit account, virtual NUBAN,
 * counterparty, transfer) is addressed explicitly through a JSON:API envelope.
 *
 * Non-negotiables this module encodes, all verified against Anchor's OpenAPI
 * spec and docs.getanchor.co:
 *
 *  - Auth is the `x-anchor-key` header, never a Bearer token.
 *  - Amounts are integer minor units (kobo). Unlike Bachs, Anchor never takes a
 *    decimal string — koboToDecimalString/decimalStringToKobo are gone.
 *  - `reference` must match ^[a-z\d\-_\s]+$ — LOWERCASE ONLY. Our own refs look
 *    like "DVY-4821-7735", so everything crossing this boundary goes through
 *    toAnchorRef()/fromAnchorRef().
 *  - Money-moving calls carry x-anchor-idempotent-key derived from our own
 *    reference, the same discipline the Bachs client used.
 *  - Anchor deducts its own fees (TRANSFER_FEE, STAMP_DUTY, PAYMENT_COLLECTION)
 *    as separate CustomerFee rows against the account — they are NOT netted off
 *    a credited amount, so our recorded gross always matches what was sent.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface AnchorErrorEntry {
  title?: string;
  status?: string;
  detail?: string;
}

export class AnchorApiError extends Error {
  status: number;
  title?: string;
  detail?: string;
  body: unknown;
  constructor(status: number, body: { errors?: AnchorErrorEntry[] }) {
    const first = body.errors?.[0];
    super(first?.detail ?? first?.title ?? `Anchor API error (${status})`);
    this.name = 'AnchorApiError';
    this.status = status;
    this.title = first?.title;
    this.detail = first?.detail;
    this.body = body;
  }

  /** Anchor reports a customer that hasn't finished KYC as a 412. */
  get isKycIncomplete(): boolean {
    return this.status === 412 && /kyc/i.test(`${this.title ?? ''} ${this.detail ?? ''}`);
  }

  /** Transfers rejected for want of funds — the sweep defers on these rather than logging. */
  get isInsufficientBalance(): boolean {
    return /insufficient[_ ]balance/i.test(`${this.title ?? ''} ${this.detail ?? ''}`);
  }
}

interface AnchorRequestOpts {
  method?: string;
  idempotencyKey?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

/** A JSON:API resource object as Anchor returns it. */
export interface AnchorResource<A = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: A;
  relationships?: Record<string, unknown>;
}

interface AnchorEnvelope<D> {
  data: D;
  included?: AnchorResource[];
  meta?: Record<string, unknown>;
}

async function anchorFetch<D>(path: string, opts: AnchorRequestOpts = {}): Promise<AnchorEnvelope<D>> {
  const headers: Record<string, string> = {
    'x-anchor-key': env.ANCHOR_SECRET_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (opts.idempotencyKey) headers['x-anchor-idempotent-key'] = opts.idempotencyKey;

  const entries = Object.entries(opts.query ?? {}).filter((e): e is [string, string | number] => e[1] !== undefined);
  const qs = entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)] as [string, string])).toString()}` : '';

  const res = await fetch(`${env.ANCHOR_BASE_URL}${path}${qs}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[anchor] ${path} failed (${res.status}):`, JSON.stringify(json));
    throw new AnchorApiError(res.status, json as { errors?: AnchorErrorEntry[] });
  }
  return json as AnchorEnvelope<D>;
}

// ---------------------------------------------------------------------------
// References — Anchor's `reference` pattern is ^[a-z\d\-_\s]+$, so our
// "DVY-4821-7735" has to travel lowercased. The transform is total and
// reversible because our own generator only ever emits [A-Z0-9-].
// ---------------------------------------------------------------------------

const ANCHOR_REFERENCE_PATTERN = /^[a-z\d\-_\s]+$/;

export function toAnchorRef(reference: string): string {
  const lowered = reference.toLowerCase();
  if (!ANCHOR_REFERENCE_PATTERN.test(lowered)) {
    throw new Error(`toAnchorRef: "${reference}" cannot be represented as an Anchor reference`);
  }
  return lowered;
}

export function fromAnchorRef(reference: string): string {
  return reference.toUpperCase();
}

// ---------------------------------------------------------------------------
// Customers — the rep is an IndividualCustomer. Address is mandatory at
// creation, which is why the customer is created at KYC submission (the first
// point we hold one) rather than at admin approval.
// ---------------------------------------------------------------------------

/** Anchor's state enum is upper snake case — "AKWA_IBOM", "CROSS_RIVER", "FCT". */
export type NigerianState =
  | 'KANO' | 'LAGOS' | 'KADUNA' | 'KATSINA' | 'OYO' | 'RIVERS' | 'BAUCHI' | 'JIGAWA' | 'BENUE'
  | 'ANAMBRA' | 'BORNO' | 'DELTA' | 'NIGER' | 'IMO' | 'AKWA_IBOM' | 'OGUN' | 'SOKOTO' | 'ONDO'
  | 'OSUN' | 'KOGI' | 'ZAMFARA' | 'ENUGU' | 'KEBBI' | 'EDO' | 'PLATEAU' | 'ADAMAWA'
  | 'CROSS_RIVER' | 'ABIA' | 'EKITI' | 'KWARA' | 'GOMBE' | 'YOBE' | 'TARABA' | 'EBONYI'
  | 'NASARAWA' | 'BAYELSA' | 'FCT';

export const NIGERIAN_STATES = [
  'KANO', 'LAGOS', 'KADUNA', 'KATSINA', 'OYO', 'RIVERS', 'BAUCHI', 'JIGAWA', 'BENUE',
  'ANAMBRA', 'BORNO', 'DELTA', 'NIGER', 'IMO', 'AKWA_IBOM', 'OGUN', 'SOKOTO', 'ONDO',
  'OSUN', 'KOGI', 'ZAMFARA', 'ENUGU', 'KEBBI', 'EDO', 'PLATEAU', 'ADAMAWA',
  'CROSS_RIVER', 'ABIA', 'EKITI', 'KWARA', 'GOMBE', 'YOBE', 'TARABA', 'EBONYI',
  'NASARAWA', 'BAYELSA', 'FCT',
] as const satisfies readonly NigerianState[];

export interface AnchorAddress {
  addressLine_1: string;
  addressLine_2?: string;
  country: 'NG';
  city: string;
  postalCode: string;
  state: NigerianState;
}

export type Gender = 'Male' | 'Female' | 'Others';

export type VerificationStatus = 'pending' | 'approved' | 'rejected' | 'pending.manual.review' | 'unverified';

export interface CustomerAttributes {
  email: string;
  phoneNumber: string;
  fullName: { firstName: string; lastName: string; middleName?: string };
  address: AnchorAddress;
  status: 'ACTIVE' | 'EXPIRED' | 'DELETED' | 'IN_ACTIVE';
  verification?: { level?: string; status?: VerificationStatus; comment?: string };
  createdAt: string;
}

export async function createIndividualCustomer(input: {
  firstName: string;
  lastName: string;
  middleName?: string;
  email: string;
  phoneNumber: string;
  address: AnchorAddress;
}): Promise<AnchorResource<CustomerAttributes>> {
  const { data } = await anchorFetch<AnchorResource<CustomerAttributes>>('/api/v1/customers', {
    body: {
      data: {
        type: 'IndividualCustomer',
        attributes: {
          fullName: {
            firstName: input.firstName,
            lastName: input.lastName,
            ...(input.middleName ? { middleName: input.middleName } : {}),
          },
          email: input.email,
          phoneNumber: input.phoneNumber,
          address: input.address,
        },
      },
    },
  });
  return data;
}

export async function getCustomer(customerId: string): Promise<AnchorResource<CustomerAttributes> | null> {
  try {
    const { data } = await anchorFetch<AnchorResource<CustomerAttributes>>(
      `/api/v1/customers/${encodeURIComponent(customerId)}`,
    );
    return data;
  } catch (err) {
    if (err instanceof AnchorApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * BVN-tier identity verification.
 *
 * TIER NAMING — READ BEFORE CHANGING. Anchor's prose docs call this "Tier 1",
 * but the API's `level` enum accepts only TIER_2 and TIER_3, and the BVN
 * payload goes in a `level2` object. The fee-type enum (KYC_TIER_2 /
 * KYC_TIER_3) confirms this is the tier the pricing sheet lists at ₦50. Do not
 * "correct" this to TIER_1 — the request is rejected.
 *
 * Asynchronous: a 200 means only that the check was accepted. The outcome
 * arrives as customer.identification.approved / .rejected / .error. The BVN is
 * never persisted on our side (PRD §8).
 */
export async function submitTier2Verification(
  customerId: string,
  input: { bvn: string; dateOfBirth: string; gender: Gender },
): Promise<void> {
  await anchorFetch(`/api/v1/customers/${encodeURIComponent(customerId)}/verification/individual`, {
    body: {
      data: {
        type: 'Verification',
        attributes: {
          level: 'TIER_2',
          level2: { bvn: input.bvn, dateOfBirth: input.dateOfBirth, gender: input.gender },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Deposit accounts — the space's collecting account, owned by the rep's
// verified customer. Creation requires a completed KYC level (412 otherwise),
// and the account NUMBER is assigned asynchronously, so it is fetched
// separately rather than read off the creation response.
// ---------------------------------------------------------------------------

export interface DepositAccountAttributes {
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  currency: 'NGN' | 'USD';
  type?: string;
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED' | 'DEPRECATED';
  frozen?: boolean;
  bank?: { id: string; name: string; nipCode?: string; cbnCode?: string };
  createdAt: string;
}

export async function createDepositAccount(customerId: string): Promise<AnchorResource<DepositAccountAttributes>> {
  const { data } = await anchorFetch<AnchorResource<DepositAccountAttributes>>('/api/v1/accounts', {
    body: {
      data: {
        type: 'DepositAccount',
        // SAVINGS is the only product an individual customer may hold; CURRENT
        // is reserved for business customers.
        attributes: { productName: 'SAVINGS' },
        relationships: { customer: { data: { id: customerId, type: 'IndividualCustomer' } } },
      },
    },
  });
  return data;
}

/** Fetches an account with its (asynchronously assigned) account number resolved. */
export async function getAccount(accountId: string): Promise<AnchorResource<DepositAccountAttributes> | null> {
  try {
    const { data } = await anchorFetch<AnchorResource<DepositAccountAttributes>>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}`,
      { query: { include: 'AccountNumber' } },
    );
    return data;
  } catch (err) {
    if (err instanceof AnchorApiError && err.status === 404) return null;
    throw err;
  }
}

export interface AccountBalance {
  availableBalance: number; // kobo
  ledgerBalance: number; // kobo
  hold?: number;
  pending?: number;
}

export async function getAccountBalance(accountId: string): Promise<AccountBalance> {
  const { data } = await anchorFetch<AnchorResource<AccountBalance>>(
    `/api/v1/accounts/balance/${encodeURIComponent(accountId)}`,
  );
  return data.attributes;
}

// ---------------------------------------------------------------------------
// Virtual NUBANs — one dynamic, expiring account per checkout, settling into
// the space's deposit account.
//
// NOTE THE VERSION: this is the only /api/v2 endpoint we call. It is documented
// at docs.getanchor.co/reference/create-a-virtual-nuban but absent from the
// published OpenAPI document, which is stale — do not "fix" the path to v1 on
// the strength of the spec.
//
// Two request-shape traps, both of which the OpenAPI schema would mislead you on:
//  - `customer` is REQUIRED alongside `settlementAccount`. It is the account
//    holder (the rep), not the payer, and it is what the response's accountName
//    is derived from — so the student sees the rep's verified name.
//  - `expiryDate` is NOT a request attribute. Anchor decides the account's
//    lifetime; we cannot ask for 30 minutes. Our own countdown is therefore a
//    Duevy-side construct (PendingPayment.expiresAt) and a late transfer can
//    still land — handled as an unmatched inflow per PRD §9.1.
//
// A virtual NUBAN carries no `amount`, so it does NOT enforce what the payer
// sends. Matching is by account; under/overpayment is reconciled by
// fulfilByReference() against our own recorded total (PRD §9.1).
// ---------------------------------------------------------------------------

export interface VirtualNubanAttributes {
  accountNumber: string;
  accountName: string;
  currency: 'NGN' | 'USD';
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED' | 'DEPRECATED';
  reference?: string;
  permanent: boolean;
  expiryDate?: string;
  bank?: { id: string; name: string; nipCode?: string };
  createdAt: string;
}

export interface VirtualNuban {
  id: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  expiresAt: Date;
}

export async function createVirtualNuban(input: {
  settlementAccountId: string;
  customerId: string;
  reference: string;
  /** Only a UI/PendingPayment countdown — Anchor sets the real lifetime. */
  expirySeconds: number;
  metadata?: Record<string, string>;
}): Promise<VirtualNuban> {
  const fallbackExpiry = new Date(Date.now() + input.expirySeconds * 1000);
  const { data } = await anchorFetch<AnchorResource<VirtualNubanAttributes>>('/api/v2/virtual-nubans', {
    body: {
      data: {
        type: 'VirtualNuban',
        attributes: {
          permanent: false, // dynamic — expires, rather than a reserved account
          reference: toAnchorRef(input.reference),
          ...(env.ANCHOR_VA_PROVIDER ? { provider: env.ANCHOR_VA_PROVIDER } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        relationships: {
          customer: { data: { id: input.customerId, type: 'IndividualCustomerNG' } },
          settlementAccount: { data: { id: input.settlementAccountId, type: 'DepositAccount' } },
        },
      },
    },
  });

  return {
    id: data.id,
    accountNumber: data.attributes.accountNumber,
    accountName: data.attributes.accountName,
    bankName: data.attributes.bank?.name ?? 'Anchor',
    // Anchor's own expiry wins when it sends one; ours is only a fallback.
    expiresAt: data.attributes.expiryDate ? new Date(data.attributes.expiryDate) : fallbackExpiry,
  };
}

/**
 * Best-effort close of an expired or abandoned checkout account. Never throws.
 *
 * UNVERIFIED, AND CURRENTLY UNCALLED. Creation is documented at /api/v2, but no
 * close/deactivate endpoint appears in the docs or the OpenAPI document, so both
 * the verb and the version below are guesses. Wiring this up matters more than
 * it looks: because Anchor — not us — sets the account's lifetime, an abandoned
 * checkout stays open after our 30-minute countdown lapses, and a late transfer
 * lands as an unmatched inflow (PRD §9.1). Confirm the real endpoint with Anchor
 * before calling this.
 */
export async function closeVirtualNuban(virtualNubanId: string): Promise<void> {
  try {
    await anchorFetch(`/api/v2/virtual-nubans/${encodeURIComponent(virtualNubanId)}`, { method: 'DELETE' });
  } catch (err) {
    console.error(`[anchor] closing virtual nuban ${virtualNubanId} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Banks & counterparties — the payout destination. Unlike Bachs, bank lookup
// and name enquiry are organisation-level, not scoped per connected account.
// ---------------------------------------------------------------------------

export interface Bank {
  id: string;
  code: string; // nipCode — the six-digit NIP code clients pass back to us
  name: string;
}

export async function getBanks(): Promise<Bank[]> {
  const { data } = await anchorFetch<Array<AnchorResource<{ name: string; nipCode?: string; cbnCode?: string }>>>(
    '/api/v1/banks',
  );
  return data
    .filter((b) => !!b.attributes.nipCode)
    .map((b) => ({ id: b.id, code: b.attributes.nipCode as string, name: b.attributes.name }));
}

/** Name enquiry. Returns null when the account can't be resolved — same contract the old client had. */
export async function verifyAccount(bankCode: string, accountNumber: string): Promise<string | null> {
  try {
    const { data } = await anchorFetch<AnchorResource<{ accountName?: string; accountNumber?: string }>>(
      `/api/v1/payments/verify-account/${encodeURIComponent(bankCode)}/${encodeURIComponent(accountNumber)}`,
    );
    return data.attributes.accountName ?? null;
  } catch {
    return null;
  }
}

/**
 * Registers the rep's bank account as a transfer destination.
 * `verifyName: true` makes Anchor re-resolve the name at the recipient bank and
 * return the authoritative one, overriding whatever we submitted — which keeps
 * the rule that a payout account name is always server-resolved, never
 * client-supplied.
 */
export async function createCounterParty(input: {
  bankCode: string;
  accountNumber: string;
  accountName: string;
}): Promise<{ id: string; accountName: string }> {
  const { data } = await anchorFetch<AnchorResource<{ accountName: string; accountNumber: string }>>(
    '/api/v1/counterparties',
    {
      body: {
        data: {
          type: 'CounterParty',
          attributes: {
            bankCode: input.bankCode,
            accountNumber: input.accountNumber,
            accountName: input.accountName,
            verifyName: true,
          },
        },
      },
    },
  );
  return { id: data.id, accountName: data.attributes.accountName };
}

// ---------------------------------------------------------------------------
// Transfers — NIP out to a counterparty (payouts), Book between our own
// accounts (the service-charge sweep).
// ---------------------------------------------------------------------------

export type TransferStatus =
  | 'PENDING' | 'FAILED' | 'FAILED_RETRYING' | 'IN_PROGRESS' | 'PARTIAL_SUCCESS' | 'COMPLETED'
  | 'REVERSED' | 'RETURNED' | 'REVERSAL_IN_PROGRESS' | 'RETRYING' | 'REVERSAL_IMPOSSIBLE'
  | 'NOT_START' | 'NOT_VALID' | 'INITIATED' | 'PENDING_REVIEW' | 'PROCESSING' | 'SETTLED'
  | 'REJECTED' | 'SUBMITTED' | 'CANCELED' | 'SENT' | 'DISHONORED' | 'CONTESTED'
  | 'PENDING_RETURN' | 'PENDING_CANCELLATION';

/** Terminal success for a transfer we initiated. */
export const TRANSFER_SUCCESS: ReadonlySet<string> = new Set<TransferStatus>(['COMPLETED', 'SETTLED']);
/** Terminal failure — the money is not going to arrive. */
export const TRANSFER_FAILURE: ReadonlySet<string> = new Set<TransferStatus>([
  'FAILED', 'REJECTED', 'REVERSED', 'RETURNED', 'NOT_VALID', 'CANCELED', 'DISHONORED',
]);

export interface TransferAttributes {
  amount: number; // kobo
  currency: 'NGN' | 'USD';
  status: TransferStatus;
  reference: string;
  reason?: string;
  failureReason?: string;
  sessionId?: string;
  createdAt: string;
}

export interface TransferResult {
  id: string;
  status: TransferStatus;
  reference: string;
  failureReason?: string;
}

function toTransferResult(data: AnchorResource<TransferAttributes>): TransferResult {
  return {
    id: data.id,
    status: data.attributes.status,
    reference: fromAnchorRef(data.attributes.reference ?? ''),
    failureReason: data.attributes.failureReason,
  };
}

/** Payout: money leaves the space's deposit account for the rep's bank. */
export async function createNipTransfer(
  input: { accountId: string; counterPartyId: string; amountKobo: number; reference: string; reason: string },
  idempotencyKey: string,
): Promise<TransferResult> {
  const { data } = await anchorFetch<AnchorResource<TransferAttributes>>('/api/v1/transfers', {
    idempotencyKey,
    body: {
      data: {
        type: 'NIPTransfer',
        attributes: {
          amount: input.amountKobo,
          currency: 'NGN',
          reason: input.reason.slice(0, 100), // Anchor caps `reason` at 100 chars
          reference: toAnchorRef(input.reference),
        },
        relationships: {
          account: { data: { id: input.accountId, type: 'DepositAccount' } },
          counterParty: { data: { id: input.counterPartyId, type: 'CounterParty' } },
        },
      },
    },
  });
  return toTransferResult(data);
}

/** Internal move between two accounts we control — the service-charge sweep. */
export async function createBookTransfer(
  input: { fromAccountId: string; toAccountId: string; amountKobo: number; reference: string; reason: string },
  idempotencyKey: string,
): Promise<TransferResult> {
  const { data } = await anchorFetch<AnchorResource<TransferAttributes>>('/api/v1/transfers', {
    idempotencyKey,
    body: {
      data: {
        type: 'BookTransfer',
        attributes: {
          amount: input.amountKobo,
          currency: 'NGN',
          reason: input.reason.slice(0, 100),
          reference: toAnchorRef(input.reference),
        },
        relationships: {
          account: { data: { id: input.fromAccountId, type: 'DepositAccount' } },
          destinationAccount: { data: { id: input.toAccountId, type: 'DepositAccount' } },
        },
      },
    },
  });
  return toTransferResult(data);
}

export async function getTransfer(transferId: string): Promise<TransferResult | null> {
  try {
    const { data } = await anchorFetch<AnchorResource<TransferAttributes>>(
      `/api/v1/transfers/${encodeURIComponent(transferId)}`,
    );
    return toTransferResult(data);
  } catch (err) {
    if (err instanceof AnchorApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Forces Anchor to re-query the provider for a transfer stuck in a non-terminal
 * state — the reconciliation job's tool for payouts sitting in `processing`.
 */
export async function verifyTransfer(transferId: string): Promise<TransferResult | null> {
  try {
    const { data } = await anchorFetch<AnchorResource<TransferAttributes>>(
      `/api/v1/transfers/verify/${encodeURIComponent(transferId)}`,
    );
    return toTransferResult(data);
  } catch (err) {
    if (err instanceof AnchorApiError && err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Transactions — the reconciliation fallback for an inflow whose webhook never
// arrived. Scoped to one account so a stale checkout can be resolved by looking
// for a credit carrying its reference.
// ---------------------------------------------------------------------------

export interface AnchorTransaction {
  id: string;
  amountKobo: number;
  direction: 'CREDIT' | 'DEBIT';
  reference?: string;
  narration?: string;
  createdAt: string;
}

interface RawTransactionAttributes {
  amount: number;
  type?: string;
  direction?: string;
  reference?: string;
  narration?: string;
  createdAt: string;
}

export async function listAccountTransactions(
  accountId: string,
  opts: { limit?: number } = {},
): Promise<AnchorTransaction[]> {
  const { data } = await anchorFetch<Array<AnchorResource<RawTransactionAttributes>>>('/api/v1/transactions', {
    query: { accountId, size: opts.limit ?? 50 },
  });
  return data.map((t) => ({
    id: t.id,
    amountKobo: t.attributes.amount,
    direction: (t.attributes.direction ?? t.attributes.type ?? '').toUpperCase() === 'DEBIT' ? 'DEBIT' : 'CREDIT',
    reference: t.attributes.reference ? fromAnchorRef(t.attributes.reference) : undefined,
    narration: t.attributes.narration,
    createdAt: t.attributes.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Webhook signature
//
// Header: x-anchor-signature
// Value:  base64( hex( HMAC_SHA1(rawBody, webhookToken) ) )
//
// Note the double encoding — Anchor's own reference implementation takes the
// HEX DIGEST STRING and base64-encodes those ASCII characters. A conventional
// base64(rawDigestBytes) does NOT match and would reject every real webhook.
// There is a unit test pinning this; do not "simplify" it.
// ---------------------------------------------------------------------------

export function computeWebhookSignature(rawBody: Buffer, secret: string): string {
  const hexDigest = createHmac('sha1', secret).update(rawBody).digest('hex');
  return Buffer.from(hexDigest, 'utf8').toString('base64');
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = computeWebhookSignature(rawBody, env.ANCHOR_WEBHOOK_SECRET);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

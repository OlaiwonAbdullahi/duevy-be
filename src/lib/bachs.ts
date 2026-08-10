import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { koboToDecimalString } from './money';

/**
 * Bachs Connect (bachs.io) API client — the sole payment processor (see
 * .claude/skills/bachs-connect/SKILL.md for the full reference this is built
 * against). Every money-moving call carries a deterministic Idempotency-Key
 * derived from our own reference; amounts are always decimal strings at
 * naira precision ("7000.00"), never numbers — see koboToDecimalString/
 * decimalStringToKobo in src/lib/money.ts.
 *
 * Functions below are grouped into DOCUMENTED (built straight from the
 * skill) and BEST-EFFORT/UNVERIFIED (the skill has no coverage for
 * checkout-session field shapes or webhook signing — implemented on the same
 * REST conventions the rest of the API uses, flagged inline). Same
 * "confirm before relying on this in prod" convention the old paystack.ts
 * client used for its own shakier endpoints.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface BachsErrorBody {
  code?: string;
  message?: string;
  errors?: Array<{ field?: string; issue?: string }>;
}

export class BachsApiError extends Error {
  status: number;
  code?: string;
  body: unknown;
  constructor(status: number, body: BachsErrorBody) {
    super(body.code ?? body.message ?? `Bachs API error (${status})`);
    this.name = 'BachsApiError';
    this.status = status;
    this.code = body.code;
    this.body = body;
  }
}

interface BachsRequestOpts {
  method?: string;
  as?: string; // X-Connected-Account-ID — runs the request "as" that connected account
  idempotencyKey?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function bachsFetch<T>(path: string, opts: BachsRequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.BACHS_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
  if (opts.as) headers['X-Connected-Account-ID'] = opts.as;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const entries = Object.entries(opts.query ?? {}).filter((e): e is [string, string | number] => e[1] !== undefined);
  const qs = entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)] as [string, string])).toString()}` : '';

  const res = await fetch(`${env.BACHS_BASE_URL}${path}${qs}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[bachs] ${path} failed (${res.status}):`, JSON.stringify(json));
    throw new BachsApiError(res.status, json as BachsErrorBody);
  }
  return json as T;
}

/** Multipart upload — Bachs's `.../uploads` endpoint, used only for onboarding documents. */
async function bachsUpload<T>(
  accountId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  scope: string,
): Promise<T> {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.filename);
  form.append('scope', scope);

  const res = await fetch(`${env.BACHS_BASE_URL}/v1/connected-accounts/${encodeURIComponent(accountId)}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BACHS_SECRET_KEY}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[bachs] upload failed (${res.status}):`, JSON.stringify(json));
    throw new BachsApiError(res.status, json as BachsErrorBody);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Platform status
// ---------------------------------------------------------------------------

export async function getPlatformStatus(): Promise<{ capabilities: { connect?: { status: string } } }> {
  return bachsFetch('/v1/organizations/me');
}

// ---------------------------------------------------------------------------
// Connected accounts (Space <-> Bachs connected account)
// ---------------------------------------------------------------------------

export type CapabilityStatus = 'active' | 'restricted' | 'pending';

export interface ConnectedAccountCapabilities {
  transfers?: { status: CapabilityStatus };
  payouts?: { status: CapabilityStatus };
  [key: string]: { status: CapabilityStatus } | undefined;
}

export interface ConnectedAccount {
  id: string; // org_...
  contact_email: string;
  display_name?: string;
  country: string;
  entity_type: 'individual' | 'company';
  capabilities: ConnectedAccountCapabilities;
  setup_status: 'incomplete' | 'awaiting_review' | 'complete';
}

export async function createConnectedAccount(input: {
  contactEmail: string;
  displayName: string;
  country?: string;
}): Promise<ConnectedAccount> {
  return bachsFetch('/v1/organizations/connected-accounts', {
    body: {
      contact_email: input.contactEmail,
      display_name: input.displayName,
      country: input.country ?? 'NG',
      entity_type: 'individual', // course reps are individuals, not registered businesses
      capabilities: { transfers: { requested: true }, payouts: { requested: true } },
    },
  });
}

export async function getConnectedAccount(accountId: string): Promise<ConnectedAccount> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}`);
}

export async function getConnectedAccountCapabilities(accountId: string): Promise<ConnectedAccountCapabilities> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/capabilities`);
}

// ---------------------------------------------------------------------------
// API onboarding (Tasks/checklist/uploads/submit + identity) — the in-app
// path this MVP uses instead of the hosted account-link redirect.
// ---------------------------------------------------------------------------

export interface RequirementField {
  key: string;
  state: 'currently_due' | 'eventually_due' | 'past_due' | 'pending_verification' | 'pending_review' | 'satisfied';
  provided: boolean;
  error_reason?: string;
  reference?: string;
}

export interface RequirementsChecklist {
  checklist: RequirementField[];
  currently_due: number;
  pending_review: number;
  in_verification: number;
  needs_attention: number;
  errors?: Array<{ field?: string; issue?: string }>;
}

export async function getRequirementsChecklist(accountId: string): Promise<RequirementsChecklist> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/requirements/checklist`);
}

export interface RequirementTask {
  title: string;
  type: 'document' | 'form_field' | 'action' | 'edit_section';
  status: string;
  due_date?: string;
  rejection_reason?: string;
  impacts_capability?: string[];
}

export async function getRequirementsTasks(accountId: string): Promise<{ tasks: RequirementTask[] }> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/requirements/tasks`);
}

export async function uploadRequirementDocument(
  accountId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  scope: string,
): Promise<{ upload_id: string }> {
  return bachsUpload(accountId, file, scope);
}

export async function submitRequirements(
  accountId: string,
  input: { country: string; draft: boolean; data: Record<string, unknown> },
): Promise<RequirementsChecklist> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/requirements/submit`, { body: input });
}

export async function getIdentityMethods(
  accountId: string,
): Promise<{ hosted_available: boolean; nin_available: boolean; country: string }> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/identity/methods`);
}

export async function getIdentityStatus(
  accountId: string,
): Promise<{ status: string; failure_reason?: string; verification_url?: string }> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/identity/status`);
}

/** `consent` must be true — the rep is attesting to a government database check; the frontend must show real consent copy before calling this. */
export async function submitNinVerification(
  accountId: string,
  input: { nin: string; consent: true; selfie?: string },
): Promise<{ status: 'verified' | 'failed' | 'pending'; reason?: string }> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/identity/nin`, { body: input });
}

/** Fallback only, for the rare case getIdentityMethods() reports nin_available: false — still in-app-initiated, but the rep completes it on a Bachs-hosted page/embed. */
export async function createIdentitySession(
  accountId: string,
): Promise<{ url: string; token: string; status: string; expires_at: string }> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/identity/session`, { body: {} });
}

/** Kept as an available primitive even though no MVP route exposes it — the hosted-link flow the skill recommends for v1, useful as a fallback or for future re-enablement. */
export async function createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<{ url: string }> {
  return bachsFetch(`/v1/connected-accounts/${encodeURIComponent(accountId)}/account-links`, {
    body: { type: 'onboarding', refresh_url: refreshUrl, return_url: returnUrl },
  });
}

// ---------------------------------------------------------------------------
// Bank lookup — connected-account-scoped, backs PUT /payout/account
// ---------------------------------------------------------------------------

export interface Bank {
  code: string;
  name: string;
}

export async function getBanksForAccount(accountId: string): Promise<Bank[]> {
  const json = await bachsFetch<{ banks: Bank[] }>(`/v1/connected-accounts/${encodeURIComponent(accountId)}/requirements/banks`);
  return json.banks;
}

/** Resolves a NUBAN to its account name. Returns null if unverifiable. */
export async function resolveAccountName(accountId: string, accountNumber: string, bankCode: string): Promise<string | null> {
  try {
    const json = await bachsFetch<{ account_name?: string }>(
      `/v1/connected-accounts/${encodeURIComponent(accountId)}/requirements/accounts/resolve`,
      { body: { account_number: accountNumber, bank_code: bankCode } },
    );
    return json.account_name ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface Balance {
  currency: string;
  available_balance: string;
  pending_balance: string;
  pending_settlements_by_day?: Array<{ date: string; amount: string; currency: string }>;
}

export async function getBalance(accountId?: string): Promise<{ balances: Balance[] }> {
  return bachsFetch('/v1/accounts/balances', accountId ? { as: accountId } : {});
}

// ---------------------------------------------------------------------------
// Transfers (the split — platform's own balance -> a connected account)
// ---------------------------------------------------------------------------

export interface TransferResult {
  id: string; // tr_...
  status: string;
  amount: string;
  currency: string;
  destination: string;
  transfer_group?: string;
}

export async function createTransfer(
  input: { destinationAccountId: string; amountKobo: number; transferGroup: string; description: string },
  idempotencyKey: string,
): Promise<TransferResult> {
  return bachsFetch('/v1/transfers', {
    idempotencyKey,
    body: {
      destination: input.destinationAccountId,
      amount: koboToDecimalString(input.amountKobo),
      currency: 'NGN',
      transfer_group: input.transferGroup,
      description: input.description,
    },
  });
}

/** Refund/clawback recovery — as the connected account, destination: 'self'. */
export async function clawbackTransfer(
  input: { accountId: string; amountKobo: number; transferGroup: string; description?: string },
  idempotencyKey: string,
): Promise<TransferResult> {
  return bachsFetch('/v1/transfers', {
    as: input.accountId,
    idempotencyKey,
    body: {
      destination: 'self',
      amount: koboToDecimalString(input.amountKobo),
      currency: 'NGN',
      transfer_group: input.transferGroup,
      ...(input.description ? { description: input.description } : {}),
    },
  });
}

export async function listTransfers(connectedAccountId: string, limit = 50): Promise<{ data: TransferResult[] }> {
  return bachsFetch('/v1/transfers', { query: { connected_account_id: connectedAccountId, limit } });
}

// ---------------------------------------------------------------------------
// Payouts — destination registration + withdrawal, always "as" the account
// ---------------------------------------------------------------------------

export async function createPayoutDestination(
  accountId: string,
  input: { bankCode: string; accountNumber: string; accountName: string },
): Promise<{ id: string }> {
  return bachsFetch('/v1/payouts/destinations', {
    as: accountId,
    body: {
      destination_type: 'bank_account',
      bank_code: input.bankCode,
      account_number: input.accountNumber,
      account_name: input.accountName,
    },
  });
}

export interface WithdrawalResult {
  id: string; // wd_...
  status: 'REQUESTED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  reference: string;
}

export async function createWithdrawal(
  accountId: string,
  input: { amountKobo: number; reference: string; email: string; payoutDestinationId: string },
  idempotencyKey: string,
): Promise<WithdrawalResult> {
  return bachsFetch('/v1/payouts/withdrawals', {
    as: accountId,
    idempotencyKey,
    body: {
      from_currency: 'NGN',
      to_currency: 'NGN',
      amount: koboToDecimalString(input.amountKobo),
      payment_method: 'BANK_TRANSFER',
      reference: input.reference,
      email: input.email,
      payout_destination_id: input.payoutDestinationId,
    },
  });
}

/** UNVERIFIED exact path — "Get Withdrawal" is named but not spelled out in the skill; guessed on REST convention (by our own `reference`, mirroring Get Transfer's pattern). */
export async function getWithdrawal(accountId: string, reference: string): Promise<WithdrawalResult | null> {
  try {
    return await bachsFetch(`/v1/payouts/withdrawals/${encodeURIComponent(reference)}`, { as: accountId });
  } catch (err) {
    if (err instanceof BachsApiError && err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Checkout / collection — BEST-EFFORT / UNVERIFIED. Nothing in the skill
// covers field shapes here; built on the same decimal-string/reference
// conventions the rest of the documented API uses. Confirm against a real
// sandbox before go-live. Always on Duevy's own account — no `as` header —
// Duevy collects the full charge itself (see the skill's Step 0/6).
// ---------------------------------------------------------------------------

export interface CheckoutSessionInput {
  amountKobo: number;
  reference: string;
  customerName: string;
  customerEmail: string;
  description: string;
  callbackPath: string;
}

export interface CheckoutSessionResult {
  reference: string;
  checkoutUrl: string;
}

export async function createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
  const json = await bachsFetch<{ id: string; url: string; reference?: string }>('/v1/checkout-sessions', {
    body: {
      amount: koboToDecimalString(input.amountKobo),
      currency: 'NGN',
      reference: input.reference,
      customer: { name: input.customerName, email: input.customerEmail },
      description: input.description,
      redirect_url: `${env.FRONTEND_URL}${input.callbackPath}`,
      metadata: { reference: input.reference },
    },
  });
  return { reference: json.reference ?? input.reference, checkoutUrl: json.url };
}

export type CheckoutStatus = 'PAID' | 'PENDING' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export async function getCheckoutSession(reference: string): Promise<{ status: CheckoutStatus } | null> {
  try {
    const json = await bachsFetch<{ status?: string }>(`/v1/checkout-sessions/${encodeURIComponent(reference)}`);
    const raw = (json.status ?? '').toLowerCase();
    const status: CheckoutStatus =
      raw === 'succeeded' || raw === 'paid'
        ? 'PAID'
        : raw === 'failed'
          ? 'FAILED'
          : raw === 'cancelled' || raw === 'canceled'
            ? 'CANCELLED'
            : raw === 'expired'
              ? 'EXPIRED'
              : 'PENDING';
    return { status };
  } catch (err) {
    if (err instanceof BachsApiError && err.status === 404) return null;
    throw err;
  }
}

// refundTransaction() is deliberately not implemented — nothing in the skill
// covers refunding a platform-collected charge. The admin refund route
// stubs a clear "not yet supported" error instead of guessing at this one.

// ---------------------------------------------------------------------------
// Webhook signature verification — UNVERIFIED. The skill documents webhook
// event registration/payloads but not the signing scheme (header name,
// algorithm). Implemented as HMAC-SHA256 over the raw body against
// BACHS_WEBHOOK_SECRET; confirm both against the Bachs dashboard/docs before
// relying on this for a production go-live.
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', env.BACHS_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

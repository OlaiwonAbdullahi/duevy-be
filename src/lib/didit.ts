import { env } from '../config/env';
import { logger } from './logger';

/**
 * Didit (docs.didit.me) — rep KYC.
 *
 *  - NIN and BVN: POST /v3/database-validation/ checks each number, with the
 *    name and date of birth, against Nigeria's registries and answers
 *    synchronously. One request per number.
 *  - Phone: POST /v3/phone/send/ texts a one-time code (valid 5 minutes);
 *    POST /v3/phone/check/ verifies it.
 *
 * Authenticated with `x-api-key`. The NIN, BVN, date of birth and OTP code are
 * passed through and never logged; only outcomes and Didit's request ids are.
 */

const TIMEOUT_MS = 20_000;

/**
 * A Didit call failed. `retryable` is true for network errors, 429 and 5xx
 * (including 502 `phone_provider_unavailable`), which mean "try again", never
 * "the details were wrong".
 */
export class DiditError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DiditError';
  }
}

async function post<T>(path: string, body: Record<string, unknown>, op: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL(path, env.DIDIT_BASE_URL), {
      method: 'POST',
      headers: { 'x-api-key': env.DIDIT_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ op, err: (err as Error).message }, 'didit request did not complete');
    throw new DiditError(`Didit ${op} did not complete`, null, null, true);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof json.code === 'string' ? json.code : null;
    logger.warn({ op, status: res.status, code }, 'didit request failed');
    throw new DiditError(
      typeof json.detail === 'string' ? json.detail : `Didit ${op} failed with ${res.status}`,
      res.status,
      code,
      res.status === 429 || res.status >= 500,
    );
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// NIN / BVN — database validation
// ---------------------------------------------------------------------------

export type IdOutcome = 'approved' | 'declined' | 'in_review';
export type IdKind = 'nin' | 'bvn';

export interface IdCheckInput {
  userId: string;
  kind: IdKind;
  /** The 11-digit NIN or BVN. */
  number: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dob: string;
}

export interface IdCheckResult {
  kind: IdKind;
  outcome: IdOutcome;
  requestId: string | null;
  /** Didit's overall match: full_match | partial_match | no_match. */
  matchType: string | null;
  /** Why it was declined, in words a rep can act on. */
  reason: string | null;
}

interface DatabaseValidationResponse {
  request_id?: string;
  database_validation?: {
    status?: 'Approved' | 'Declined' | 'In Review';
    match_type?: string | null;
    validations?: { outcome_code?: string }[] | Record<string, string>;
  };
}

function declineReason(code: string | undefined, label: string): string {
  switch (code) {
    case 'PARTIAL_MATCH':
      return `Only part of your details matched the ${label} record`;
    case 'DOCUMENT_NOT_FOUND':
      return `No record was found for that ${label}`;
    case 'INVALID_DOCUMENT_FORMAT':
      return `That ${label} is not in a valid format`;
    case 'INVALID_INPUT':
      return 'Some of the details were not accepted';
    case 'DECEASED':
      return `The ${label} record could not be used`;
    default:
      return `The name or date of birth does not match the ${label} record`;
  }
}

/** Check one NIN or BVN, with the name and date of birth, against the registry. */
export async function verifyIdNumber(input: IdCheckInput): Promise<IdCheckResult> {
  const label = input.kind.toUpperCase();
  const r = await post<DatabaseValidationResponse>(
    '/v3/database-validation/',
    {
      issuing_state: 'NGA',
      // `identification_number` is Didit's universal field (the NIN for NGA);
      // the BVN has its own.
      ...(input.kind === 'nin' ? { identification_number: input.number } : { bvn: input.number }),
      first_name: input.firstName,
      last_name: input.lastName,
      date_of_birth: input.dob,
      vendor_data: input.userId,
      consent: true,
    },
    `${input.kind}.verify`,
  );
  const v = r.database_validation ?? {};
  const outcome: IdOutcome = v.status === 'Approved' ? 'approved' : v.status === 'Declined' ? 'declined' : 'in_review';
  const codes = Array.isArray(v.validations) ? v.validations.map((x) => x.outcome_code).filter((c): c is string => !!c) : [];
  const reason = outcome === 'declined' ? declineReason(codes[0], label) : null;
  logger.info({ userId: input.userId, kind: input.kind, requestId: r.request_id, outcome, matchType: v.match_type, codes }, 'didit id checked');
  return { kind: input.kind, outcome, requestId: r.request_id ?? null, matchType: v.match_type ?? null, reason };
}

// ---------------------------------------------------------------------------
// Phone — OTP
// ---------------------------------------------------------------------------

/** "08012345678", "2348012345678", "+234 801 234 5678" → "+2348012345678". Null if it isn't a Nigerian mobile. */
export function normaliseNigerianPhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '');
  const m = /^(?:\+?234|0)([789][01]\d{8})$/.exec(digits);
  return m ? `+234${m[1]}` : null;
}

export type PhoneSendOutcome = 'sent' | 'blocked';

export async function sendPhoneCode(userId: string, phone: string): Promise<PhoneSendOutcome> {
  const r = await post<{ status?: string; reason?: string | null; request_id?: string }>(
    '/v3/phone/send/',
    { phone_number: phone, vendor_data: userId },
    'phone.send',
  );
  // Success and Retry both mean a code is on its way; Blocked is final.
  const outcome: PhoneSendOutcome = r.status === 'Blocked' ? 'blocked' : 'sent';
  logger.info({ userId, requestId: r.request_id, status: r.status, reason: r.reason }, 'didit phone code sent');
  return outcome;
}

export type PhoneCheckOutcome = 'approved' | 'wrong_code' | 'declined' | 'expired';

export interface PhoneCheckResult {
  outcome: PhoneCheckOutcome;
  message: string | null;
}

export async function checkPhoneCode(userId: string, phone: string, code: string): Promise<PhoneCheckResult> {
  const r = await post<{ status?: string; message?: string | null; request_id?: string }>(
    '/v3/phone/check/',
    {
      phone_number: phone,
      code,
      // One rep, one real phone: no number another user already verified, no
      // burner or VoIP lines.
      duplicated_phone_number_action: 'DECLINE',
      disposable_number_action: 'DECLINE',
      voip_number_action: 'DECLINE',
    },
    'phone.check',
  );
  const outcome: PhoneCheckOutcome =
    r.status === 'Approved' ? 'approved' : r.status === 'Failed' ? 'wrong_code' : r.status === 'Declined' ? 'declined' : 'expired';
  logger.info({ userId, requestId: r.request_id, status: r.status }, 'didit phone code checked');
  return { outcome, message: r.message ?? null };
}

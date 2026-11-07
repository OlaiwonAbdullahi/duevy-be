import { logger } from '../../lib/logger';
import { type IdentityVerifier, type NinCheckResult, type NinOutcome, type VerifyNinInput } from './types';

/**
 * Didit's standalone database validation for Nigeria
 * (docs.didit.me/api-reference/database-validation/nigeria/national-id):
 *
 *   POST /v3/database-validation/   multipart, x-api-key
 *     issuing_state=NGA, services=nga_national_id,
 *     first_name, last_name, national_id, date_of_birth, vendor_data
 *
 * One synchronous call, no session or selfie. The answer is each service's
 * `outcome_code` (MATCH | PARTIAL_MATCH | NO_MATCH, or REGISTRY_UNAVAILABLE /
 * REGISTRY_ERROR when NIMC can't be reached) — never the HTTP status alone.
 * The request is never logged: it carries the NIN and date of birth.
 */

const TIMEOUT_MS = 30_000;

interface Validation {
  service_id?: string;
  outcome_code?: string;
  source_data?: { name_match_score?: string | number | null } | null;
}
interface DiditResponse {
  request_id?: string;
  validations?: Validation[];
}

/**
 * Every outcome_code Didit documents for database validation
 * (docs.didit.me/core-technology/database-validation/database-validation-outcome-codes).
 * Unknown codes are treated as "the check didn't run", never as a verdict.
 */
export function outcomeFrom(code: string | undefined): NinOutcome {
  switch ((code ?? '').toUpperCase()) {
    case 'MATCH':
      return 'match';
    // Partly matched, or the register couldn't decide: an admin reviews it.
    case 'PARTIAL_MATCH':
    case 'INCONCLUSIVE':
      return 'partial';
    // The register answered, and it isn't a valid NIN for this person: the rep
    // should check what they typed (it counts as an attempt).
    case 'NO_MATCH':
    case 'DOCUMENT_NOT_FOUND':
    case 'DOCUMENT_SUPERSEDED':
    case 'INVALID_DOCUMENT_FORMAT':
    case 'DECEASED':
    case 'MINOR_BLOCKED':
      return 'no_match';
    case 'INVALID_INPUT':
      return 'invalid_input';
    // REGISTRY_UNAVAILABLE, REGISTRY_ERROR, anything new.
    default:
      return 'unavailable';
  }
}

/**
 * Didit accepts names matching [A-Za-zÀ-ÖØ-öø-ÿ .'-]+ and answers 400
 * otherwise. Nigerian names are often written with diacritics outside that
 * range (ọ, ẹ, ṣ, tone marks): strip combining marks (Adébáyọ̀ → Adebayo) and
 * anything else it can't take. The register matches on letters anyway.
 */
export function diditName(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z .'-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || name.trim();
}

export class DiditVerifier implements IdentityVerifier {
  readonly name = 'didit';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async verifyNin(input: VerifyNinInput): Promise<NinCheckResult> {
    const form = new FormData();
    form.set('issuing_state', 'NGA');
    form.set('services', 'nga_national_id');
    form.set('first_name', diditName(input.firstName));
    form.set('last_name', diditName(input.lastName));
    form.set('national_id', input.nin);
    form.set('date_of_birth', input.dob);
    form.set('vendor_data', input.userId);

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(new URL('/v3/database-validation/', this.baseUrl), {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ userId: input.userId, err: (err as Error).message }, 'didit request did not complete');
      return { outcome: 'unavailable', requestId: null, nameMatchScore: null };
    }

    let body: DiditResponse & { detail?: unknown; error?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON body: treated as unavailable below */
    }
    const validation = body.validations?.find((v) => v.service_id === 'nga_national_id') ?? body.validations?.[0];
    // Didit's own message, for the logs. It describes the error (e.g. "database
    // validation is disabled until your organization's first top-up"), never
    // echoes the NIN or date of birth; capped all the same.
    const reason = String(body.detail ?? body.error ?? '').slice(0, 200) || null;

    let outcome: NinOutcome;
    if (res.status === 400) {
      // Refused before any lookup. The NIN and date of birth are validated on
      // our side first, so this is the request as WE built it (usually a
      // name) — not the rep's mistake, and it must not count as an attempt.
      outcome = 'invalid_input';
      logger.error({ userId: input.userId, status: res.status, reason }, 'didit refused the NIN check request; fix the request, not the rep');
    } else if (res.status === 401 || res.status === 402 || res.status === 403) {
      // Didit refused OUR account: bad key, no credits, plan not enabled.
      // Every rep is blocked until someone fixes it, so this is loud.
      outcome = 'unavailable';
      logger.error({ status: res.status, reason }, 'didit refused our account (key, credits or plan): NIN verification is down for every rep');
    } else {
      outcome = res.ok || res.status === 502 ? outcomeFrom(validation?.outcome_code) : 'unavailable';
    }
    const score = Number(validation?.source_data?.name_match_score);
    logger.info(
      { userId: input.userId, status: res.status, outcome, requestId: body.request_id ?? null, ms: Date.now() - started },
      'didit NIN check',
    );
    return {
      outcome,
      requestId: body.request_id ?? null,
      nameMatchScore: Number.isFinite(score) ? score : null,
    };
  }
}

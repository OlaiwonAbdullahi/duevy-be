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

function outcomeFrom(code: string | undefined): NinOutcome {
  switch ((code ?? '').toUpperCase()) {
    case 'MATCH':
      return 'match';
    case 'PARTIAL_MATCH':
      return 'partial';
    case 'NO_MATCH':
      return 'no_match';
    default:
      return 'unavailable';
  }
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
    form.set('first_name', input.firstName);
    form.set('last_name', input.lastName);
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

    let body: DiditResponse = {};
    try {
      body = (await res.json()) as DiditResponse;
    } catch {
      /* non-JSON body: treated as unavailable below */
    }
    const validation = body.validations?.find((v) => v.service_id === 'nga_national_id') ?? body.validations?.[0];
    // 400 = our request was refused before reaching NIMC (e.g. a malformed
    // NIN) — that is a no-match for the rep, not an outage.
    const outcome = res.status === 400 ? 'no_match' : res.ok || res.status === 502 ? outcomeFrom(validation?.outcome_code) : 'unavailable';
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

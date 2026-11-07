/**
 * Rep identity checks. A rep's NIN and date of birth are checked against the
 * national register; nothing about the result decides who owns money (the
 * space does) — it records who is accountable for running the space.
 *
 * The NIN and date of birth pass through to the verifier and are NEVER
 * persisted or logged.
 */

export interface VerifyNinInput {
  /** Our user id — the verifier links repeat checks for one person by it. */
  userId: string;
  firstName: string;
  lastName: string;
  /** 11 digits. Pass-through only. */
  nin: string;
  /** YYYY-MM-DD. Pass-through only. */
  dob: string;
}

/**
 *  - match: the NIN exists and the name and date of birth match.
 *  - partial: the NIN exists but the name or date of birth only partly matched
 *    (nicknames, spelling) — an admin decides.
 *  - no_match: the NIN wasn't found or nothing matched.
 *  - unavailable: the check didn't run (register down, or the verifier
 *    refused OUR account: key, credits, plan); not the rep's fault.
 *  - invalid_input: the verifier refused the request as we sent it (e.g. a
 *    name it can't read) before any lookup; not the rep's fault, not billed.
 */
export type NinOutcome = 'match' | 'partial' | 'no_match' | 'unavailable' | 'invalid_input';

export interface NinCheckResult {
  outcome: NinOutcome;
  /** The verifier's reference for this check, for support. */
  requestId: string | null;
  /** How closely the registered name matched, 0–1, when the verifier says. */
  nameMatchScore: number | null;
}

export interface IdentityVerifier {
  readonly name: string;
  verifyNin(input: VerifyNinInput): Promise<NinCheckResult>;
}

/**
 * The rep-identity boundary: the checks Duevy runs itself before a rep is
 * registered with the payment rail. Phone ownership by one-time code, then
 * the BVN against the rep's name and date of birth.
 *
 * Inputs (BVN, date of birth, the code) are pass-through only: never stored,
 * never logged. Implementations return our own vocabulary.
 */

export interface SendCodeInput {
  /** E.164, e.g. +2348012345678. */
  phone: string;
  /** Our user id, echoed in the provider's console for support. */
  vendorData: string;
  ip?: string;
  userAgent?: string;
}

export type SendCodeOutcome = 'sent' | 'blocked';

export interface CheckCodeResult {
  outcome: 'approved' | 'wrong_code' | 'declined' | 'expired';
  /** The verified number in E.164, when approved. */
  phone: string | null;
  /** The provider's explanation, safe to show the user. */
  message: string | null;
}

export interface ValidateBvnInput {
  bvn: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. */
  dob: string;
  vendorData: string;
}

export interface BvnResult {
  /**
   * match       the registry confirms the BVN, name and date of birth
   * partial     some fields match, some don't
   * no_match    the registry contradicts what was given
   * invalid     the BVN was refused as input (format / unknown); not billed
   * unavailable the registry couldn't answer; not billed, safe to retry
   */
  outcome: 'match' | 'partial' | 'no_match' | 'invalid' | 'unavailable';
  /** The provider's id for this check — shown to admins to open it in the provider's console. */
  requestId: string | null;
  /** Per-field verdicts, e.g. { full_name: 'full_match', date_of_birth: 'no_match' }. */
  fieldMatches: Record<string, string>;
}

export interface IdentityVerifier {
  readonly name: string;
  sendPhoneCode(input: SendCodeInput): Promise<SendCodeOutcome>;
  checkPhoneCode(phone: string, code: string): Promise<CheckCodeResult>;
  validateBvn(input: ValidateBvnInput): Promise<BvnResult>;
}

import {
  type BvnResult,
  type CheckCodeResult,
  type IdentityVerifier,
  type SendCodeInput,
  type SendCodeOutcome,
  type ValidateBvnInput,
} from '../types';

/**
 * In-memory identity verifier for tests and local development
 * (IDENTITY_PROVIDER=fake; refused in production). Any phone accepts the
 * code in `validCode`; the BVN outcome is whatever `bvnOutcome` says.
 */
export class FakeVerifier implements IdentityVerifier {
  readonly name = 'fake';

  validCode = '123456';
  sendOutcome: SendCodeOutcome = 'sent';
  /** Overrides checkPhoneCode once (e.g. 'declined' for a VoIP line). */
  nextCheckOutcome: CheckCodeResult['outcome'] | null = null;
  bvnOutcome: BvnResult['outcome'] = 'match';
  calls: { op: string; args: unknown }[] = [];
  private seq = 0;

  reset(): void {
    this.validCode = '123456';
    this.sendOutcome = 'sent';
    this.nextCheckOutcome = null;
    this.bvnOutcome = 'match';
    this.calls = [];
  }

  async sendPhoneCode(input: SendCodeInput): Promise<SendCodeOutcome> {
    this.calls.push({ op: 'sendPhoneCode', args: { phone: input.phone } });
    return this.sendOutcome;
  }

  async checkPhoneCode(phone: string, code: string): Promise<CheckCodeResult> {
    this.calls.push({ op: 'checkPhoneCode', args: { phone } });
    if (this.nextCheckOutcome) {
      const outcome = this.nextCheckOutcome;
      this.nextCheckOutcome = null;
      return { outcome, phone: outcome === 'approved' ? phone : null, message: `fake ${outcome}` };
    }
    return code === this.validCode
      ? { outcome: 'approved', phone, message: 'The verification code is correct.' }
      : { outcome: 'wrong_code', phone: null, message: 'The verification code is incorrect.' };
  }

  async validateBvn(input: ValidateBvnInput): Promise<BvnResult> {
    this.calls.push({ op: 'validateBvn', args: { firstName: input.firstName, lastName: input.lastName } });
    const outcome = this.bvnOutcome;
    return {
      outcome,
      requestId: outcome === 'invalid' || outcome === 'unavailable' ? null : `dv_fake_${++this.seq}`,
      fieldMatches: outcome === 'match' ? { full_name: 'full_match', date_of_birth: 'full_match' } : {},
    };
  }
}

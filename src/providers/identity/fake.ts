import { type IdentityVerifier, type NinCheckResult, type NinOutcome, type VerifyNinInput } from './types';

/**
 * In-memory verifier for local development and the test suite. Set `outcome`
 * to choose the answer; `calls` records who was checked (never the NIN or DOB).
 */
export class FakeVerifier implements IdentityVerifier {
  readonly name = 'fake';
  outcome: NinOutcome = 'match';
  nameMatchScore: number | null = 1;
  calls: { userId: string; firstName: string; lastName: string }[] = [];
  private seq = 0;

  reset(): void {
    this.outcome = 'match';
    this.nameMatchScore = 1;
    this.calls = [];
  }

  async verifyNin(input: VerifyNinInput): Promise<NinCheckResult> {
    this.calls.push({ userId: input.userId, firstName: input.firstName, lastName: input.lastName });
    return {
      outcome: this.outcome,
      requestId: this.outcome === 'unavailable' ? null : `req_fake_${++this.seq}`,
      nameMatchScore: this.outcome === 'partial' ? 0.62 : this.nameMatchScore,
    };
  }
}

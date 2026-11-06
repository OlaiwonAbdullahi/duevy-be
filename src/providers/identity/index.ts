import { env } from '../../config/env';
import { DiditVerifier } from './didit';
import { FakeVerifier } from './fake';
import { type IdentityVerifier } from './types';

export * from './types';
export { FakeVerifier } from './fake';

let instance: IdentityVerifier | null = null;

/** Didit when a key is set; otherwise (fake rail only, see env.ts) the in-memory verifier. */
export function getIdentityVerifier(): IdentityVerifier {
  if (instance) return instance;
  instance = env.DIDIT_API_KEY ? new DiditVerifier(env.DIDIT_BASE_URL, env.DIDIT_API_KEY) : new FakeVerifier();
  return instance;
}

/** Test seam: swap the verifier. */
export function setIdentityVerifier(verifier: IdentityVerifier | null): void {
  instance = verifier;
}

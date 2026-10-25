import { env } from '../../config/env';
import { DiditVerifier } from './didit/DiditVerifier';
import { FakeVerifier } from './fake/FakeVerifier';
import { type IdentityVerifier } from './types';

export * from './types';
export { FakeVerifier } from './fake/FakeVerifier';

let instance: IdentityVerifier | null = null;

/** The configured rep-identity checker (IDENTITY_PROVIDER). One instance per process. */
export function getIdentityVerifier(): IdentityVerifier {
  if (instance) return instance;
  instance =
    env.IDENTITY_PROVIDER === 'fake'
      ? new FakeVerifier()
      : new DiditVerifier({
          baseUrl: env.DIDIT_BASE_URL,
          apiKey: env.DIDIT_API_KEY as string,
          phoneChannel: env.DIDIT_PHONE_CHANNEL,
          bvnServiceId: env.DIDIT_BVN_SERVICE,
        });
  return instance;
}

/** Test seam: swap the verifier. */
export function setIdentityVerifier(verifier: IdentityVerifier | null): void {
  instance = verifier;
}

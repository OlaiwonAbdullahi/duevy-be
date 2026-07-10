import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name: string;
  sub: string;
}

/**
 * Verify a Google-issued ID token (§2.3) against Google's published JWKS and
 * extract the caller's identity. Reuses `jose` (already a dependency for our
 * own tokens) instead of pulling in `google-auth-library`.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID is not configured');
  }
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: env.GOOGLE_CLIENT_ID,
  });

  const email = payload.email as string | undefined;
  if (!email) throw new Error('Google token has no email claim');

  return {
    email: email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: (payload.name as string | undefined) ?? email,
    sub: payload.sub as string,
  };
}

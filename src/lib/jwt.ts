import {
  SignJWT,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { env } from '../config/env';

export interface AccessTokenPayload extends JWTPayload {
  sub: string;       // userId
  role: string;
  spaceIds: string[];
}

export interface RefreshTokenPayload extends JWTPayload {
  sub: string;       // userId
  jti: string;       // unique token id (for revocation)
}

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

/** Sign a short-lived access token (default 15 min). */
export async function signAccessToken(
  payload: Omit<AccessTokenPayload, 'iat' | 'exp'>,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_EXPIRES_IN)
    .sign(accessSecret);
}

/** Sign a long-lived refresh token (default 30 d). */
export async function signRefreshToken(
  payload: Omit<RefreshTokenPayload, 'iat' | 'exp'>,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(env.JWT_REFRESH_EXPIRES_IN)
    .sign(refreshSecret);
}

/** Verify an access token. Throws JWTExpired / JWSInvalid on failure. */
export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, accessSecret);
  return payload as AccessTokenPayload;
}

/** Verify a refresh token. Throws on failure. */
export async function verifyRefreshToken(
  token: string,
): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, refreshSecret);
  return payload as RefreshTokenPayload;
}

/** Parse the expiry string (e.g. "30d") to milliseconds for cookie maxAge. */
export function parseExpiryMs(expiry: string): number {
  const unit = expiry.slice(-1);
  const value = parseInt(expiry.slice(0, -1), 10);
  const map: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return value * (map[unit] ?? 1000);
}

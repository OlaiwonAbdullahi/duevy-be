import { randomBytes, createHash } from 'crypto';

/** Generate a random opaque token (raw value emailed/cookied to the user). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 hash of a token — only the hash is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

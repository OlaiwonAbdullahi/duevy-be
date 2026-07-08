import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../config/env';

// 32-byte key derived from a dedicated secret (or the refresh secret as fallback).
const KEY = createHash('sha256')
  .update(env.ENCRYPTION_KEY ?? env.JWT_REFRESH_SECRET)
  .digest();

/**
 * Encrypt a string with AES-256-GCM. Output: `iv:authTag:ciphertext` (hex).
 * Used for at-rest protection of bank account numbers (§10.2).
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Reverse of {@link encrypt}. Throws if the ciphertext was tampered with. */
export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** Mask a NUBAN to its last four digits, e.g. `•••• 4021`. */
export function maskAccountNumber(accountNumber: string): string {
  return `•••• ${accountNumber.slice(-4)}`;
}

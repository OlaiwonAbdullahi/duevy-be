import { randomInt } from 'crypto';

// Unambiguous alphabet (no 0/O/1/I) for human-typed join codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Build a join code like `CSSA-7F2K` from a space monogram. */
export function generateJoinCode(short: string): string {
  const prefix = short.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'DUE';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${suffix}`;
}

import bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

// Unambiguous alphabet for one-time passwords: no 0/O, 1/l/I. Emailed to a new
// co-rep so they can sign in once and set their own password.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** A random temporary password for an invited account. */
export function generateTempPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * Password / PIN hashing. Native bcrypt: the async calls run on libuv's
 * threadpool, so a burst of logins never blocks the event loop (bcryptjs,
 * used before, hashed in pure JS on the main thread — ~270 ms of CPU per
 * compare at cost 12, during which no other request, webhook included, ran).
 *
 * Hashes are standard bcrypt ($2a$/$2b$), so everything stored by bcryptjs
 * verifies unchanged. Concurrency is bounded by UV_THREADPOOL_SIZE (default 4).
 */
export function hashPassword(plain: string, rounds: number): Promise<string> {
  return bcrypt.hash(plain, rounds);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Synchronous; only for boot-time constants and test fixtures. */
export function hashPasswordSync(plain: string, rounds: number): string {
  return bcrypt.hashSync(plain, rounds);
}

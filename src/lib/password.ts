import bcrypt from 'bcrypt';

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

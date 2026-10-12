-- Admin lookups by role (flagToAdmins, admin lists).
CREATE INDEX IF NOT EXISTS "users_role_idx" ON "users"("role");

-- Checkout lists/sweeps filtered by status and ordered by creation time.
CREATE INDEX IF NOT EXISTS "checkouts_status_createdAt_idx" ON "checkouts"("status", "createdAt");

-- Redundant: "idempotency_keys_key_key" (the @unique) already indexes "key".
DROP INDEX IF EXISTS "idempotency_keys_key_idx";

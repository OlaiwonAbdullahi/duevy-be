-- Every 9jaPay payment webhook looks up the open checkouts holding the
-- credited account number (webhookProcessor: vaAccountNumber + status).
-- Without this it was a sequential scan of the whole checkouts table.
CREATE INDEX IF NOT EXISTS "checkouts_vaAccountNumber_status_idx" ON "checkouts"("vaAccountNumber", "status");

-- When the pay-page status poll last asked 9jaPay about this checkout. The
-- throttle lives in the row, not process memory, so it holds across every
-- API instance (a conditional UPDATE claims the slot).
ALTER TABLE "checkouts" ADD COLUMN IF NOT EXISTS "lastProviderCheckAt" TIMESTAMP(3);

-- Redundant: each column already has the unique index from its @unique.
-- Duplicates only cost write time and memory.
DROP INDEX IF EXISTS "refresh_tokens_tokenHash_idx";
DROP INDEX IF EXISTS "email_verifications_token_idx";
DROP INDEX IF EXISTS "password_resets_tokenHash_idx";
DROP INDEX IF EXISTS "pending_payments_reference_idx";

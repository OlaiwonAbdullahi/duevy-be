-- Withdrawal codes are now set by the lead rep, not an admin: no more
-- "reset requested" flag; a forgotten-code reset holds withdrawals for 24h.
ALTER TABLE "spaces" DROP COLUMN IF EXISTS "withdrawalPinResetRequestedAt";
ALTER TABLE "spaces" ADD COLUMN "withdrawalPinHoldUntil" TIMESTAMP(3);

ALTER TYPE "AuditAction" ADD VALUE 'withdrawal_pin_set';
ALTER TYPE "AuditAction" ADD VALUE 'withdrawal_pin_changed';
ALTER TYPE "AuditAction" ADD VALUE 'withdrawal_pin_reset';

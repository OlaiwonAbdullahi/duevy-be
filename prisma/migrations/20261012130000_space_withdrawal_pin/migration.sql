-- Admin-set 4-digit withdrawal security code per space (bcrypt hash only).
ALTER TABLE "spaces" ADD COLUMN "withdrawalPinHash" TEXT;
ALTER TABLE "spaces" ADD COLUMN "withdrawalPinSetAt" TIMESTAMP(3);
ALTER TABLE "spaces" ADD COLUMN "withdrawalPinFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "spaces" ADD COLUMN "withdrawalPinLockedUntil" TIMESTAMP(3);
ALTER TABLE "spaces" ADD COLUMN "withdrawalPinResetRequestedAt" TIMESTAMP(3);

-- A lead rep asking an admin for a new code is recorded in the space audit log.
ALTER TYPE "AuditAction" ADD VALUE 'withdrawal_pin_reset_requested';

-- Split into its own migration so these new enum values are committed
-- before any later migration references them (Postgres forbids using a
-- new enum value within the same transaction that adds it).

-- CreateEnum
CREATE TYPE "PayoutApprovalDecision" AS ENUM ('approved', 'rejected');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'due_reassigned';
ALTER TYPE "AuditAction" ADD VALUE 'payout_approval_cast';
ALTER TYPE "AuditAction" ADD VALUE 'payout_disbursement_started';
ALTER TYPE "AuditAction" ADD VALUE 'payout_cancelled';

-- AlterEnum
ALTER TYPE "PayoutStatus" ADD VALUE 'pending_approval';
ALTER TYPE "PayoutStatus" ADD VALUE 'cancelled';

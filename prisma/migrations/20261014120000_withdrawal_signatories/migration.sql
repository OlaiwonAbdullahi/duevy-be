-- Team management and multi-signatory withdrawals: a space can authorise
-- withdrawals with 2 of 3 signatories (the lead + two nominated co-reps), each
-- confirming with a one-time code Duevy emails them, instead of the security code.
CREATE TYPE "WithdrawalAuthMode" AS ENUM ('pin', 'multisig');
ALTER TABLE "spaces" ADD COLUMN "withdrawalAuthMode" "WithdrawalAuthMode" NOT NULL DEFAULT 'pin';

ALTER TABLE "space_reps" ADD COLUMN "isSignatory" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "PayoutStatus" ADD VALUE 'awaiting_approval' BEFORE 'pending';
ALTER TYPE "PayoutStatus" ADD VALUE 'cancelled';
ALTER TABLE "payouts" ADD COLUMN "approvalExpiresAt" TIMESTAMP(3);

ALTER TYPE "AuditAction" ADD VALUE 'signatories_updated';
ALTER TYPE "AuditAction" ADD VALUE 'withdrawal_mode_changed';

CREATE TABLE "payout_otps" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_otps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payout_otps_payoutId_userId_key" ON "payout_otps"("payoutId", "userId");
ALTER TABLE "payout_otps" ADD CONSTRAINT "payout_otps_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_otps" ADD CONSTRAINT "payout_otps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

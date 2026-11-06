-- Bachs → 9jaPay, rep KYC → Didit (NIN + date of birth). Data-preserving.
--
--  * Collections now settle into Duevy's 9jaPay business account and are swept
--    into each space's own permanent account (spaces.wallet*, sweeps). No rep
--    holds a provider account; the Bachs columns stay, read-only, for history.
--  * Reps already verified (Bachs NIN + approved student ID) stay verified.
--    Anyone mid-verification at Bachs starts again with a clean slate.
--  * Existing rows keep provider = 'bachs'; new rows default to 'ninejapay'.

-- CreateEnum
CREATE TYPE "SweepStatus" AS ENUM ('pending', 'processing', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "SweepTrigger" AS ENUM ('daily', 'withdrawal');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "diditRequestId" TEXT,
ADD COLUMN     "ninCheckOutcome" TEXT,
ADD COLUMN     "ninNameMatchScore" DOUBLE PRECISION,
ADD COLUMN     "ninReviewNote" TEXT,
ADD COLUMN     "ninReviewStatus" "DocumentReviewStatus",
ADD COLUMN     "ninReviewedAt" TIMESTAMP(3),
ADD COLUMN     "ninReviewedById" TEXT;

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "walletAccountId" TEXT,
ADD COLUMN     "walletAccountName" TEXT,
ADD COLUMN     "walletAccountNumber" TEXT,
ADD COLUMN     "walletBankCode" TEXT,
ADD COLUMN     "walletBankName" TEXT,
ADD COLUMN     "walletCreatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "checkouts" ALTER COLUMN "provider" SET DEFAULT 'ninejapay';

-- AlterTable
ALTER TABLE "webhook_events" ALTER COLUMN "provider" SET DEFAULT 'ninejapay';

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "accountNumberEnc" TEXT,
ADD COLUMN     "bankCode" TEXT,
ADD COLUMN     "sweepId" TEXT,
ALTER COLUMN "provider" SET DEFAULT 'ninejapay';

-- CreateTable
CREATE TABLE "sweeps" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "feeKobo" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT NOT NULL,
    "providerReference" TEXT,
    "status" "SweepStatus" NOT NULL DEFAULT 'pending',
    "trigger" "SweepTrigger" NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "sweeps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sweeps_reference_key" ON "sweeps"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "sweeps_providerReference_key" ON "sweeps"("providerReference");

-- CreateIndex
CREATE INDEX "sweeps_spaceId_createdAt_idx" ON "sweeps"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "sweeps_status_createdAt_idx" ON "sweeps"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_walletAccountId_key" ON "spaces"("walletAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_walletAccountNumber_key" ON "spaces"("walletAccountNumber");

-- CreateIndex
CREATE INDEX "payouts_sweepId_idx" ON "payouts"("sweepId");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_sweepId_fkey" FOREIGN KEY ("sweepId") REFERENCES "sweeps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Reps who hadn't finished Bachs verification start again through Didit.
UPDATE "users"
SET "kycStatus" = 'unverified',
    "kycAttempts" = 0,
    "kycRetryLockedUntil" = NULL,
    "kycRejectionReason" = NULL,
    "kycSubmittedAt" = NULL,
    "kycResolvedAt" = NULL,
    "kycRequirementsDue" = '{}'
WHERE "kycStatus" IN ('pending', 'rejected');

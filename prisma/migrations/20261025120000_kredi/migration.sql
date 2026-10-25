-- =============================================================================
-- Bachs -> Kredi Pay, and Didit identity gates. See docs/KREDI.md.
--
-- Money is pooled in Duevy's Kredi merchant account and owned per space by the
-- ledger, so the per-rep Connect account, payout destinations and fee
-- settlement go away. Reps re-verify: phone OTP + BVN match (Didit), then a
-- Kredi customer record. A Bachs account id means nothing at Kredi, so every
-- rep's provider identity is reset here (development data only — Bachs never
-- held live money).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS "users_bachsAccountId_key";
ALTER TABLE "users" RENAME COLUMN "bachsAccountId" TO "providerAccountId";
ALTER TABLE "users" RENAME COLUMN "bachsPayoutsActive" TO "payoutsActive";
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "bachsPersonId",
  DROP COLUMN IF EXISTS "kycRequirementsDue",
  DROP COLUMN IF EXISTS "governmentIdSubmittedAt",
  ADD COLUMN "providerAccountNumber" TEXT,
  ADD COLUMN "verifiedPhone" TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "pendingPhone" TEXT,
  ADD COLUMN "phoneOtpSentAt" TIMESTAMP(3),
  ADD COLUMN "phoneOtpSendCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "phoneOtpWindowStartedAt" TIMESTAMP(3),
  ADD COLUMN "bvnHash" TEXT,
  ADD COLUMN "bvnVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "diditBvnRequestId" TEXT,
  ADD COLUMN "kycConsentAt" TIMESTAMP(3);

-- Bachs identities don't carry over: every rep verifies again through Didit + Kredi.
UPDATE "users"
SET "providerAccountId" = NULL,
    "payoutsActive" = false,
    "kycStatus" = CASE WHEN "kycStatus" IN ('verified', 'pending') THEN 'unverified'::"KycStatus" ELSE "kycStatus" END,
    "kycResolvedAt" = NULL,
    "kycAttempts" = 0,
    "kycRetryLockedUntil" = NULL
WHERE "providerAccountId" IS NOT NULL OR "kycStatus" IN ('verified', 'pending');

CREATE UNIQUE INDEX "users_providerAccountId_key" ON "users"("providerAccountId");
CREATE UNIQUE INDEX "users_verifiedPhone_key" ON "users"("verifiedPhone");
CREATE UNIQUE INDEX "users_bvnHash_key" ON "users"("bvnHash");

-- -----------------------------------------------------------------------------
-- checkouts / webhook_events: pooled collections, Kredi by default
-- -----------------------------------------------------------------------------
ALTER TABLE "checkouts" DROP COLUMN IF EXISTS "destinationAccountId";
ALTER TABLE "checkouts" ALTER COLUMN "provider" SET DEFAULT 'kredi';
ALTER TABLE "webhook_events" ALTER COLUMN "provider" SET DEFAULT 'kredi';

-- -----------------------------------------------------------------------------
-- payout_beneficiaries: no provider-side destination registry at Kredi
-- -----------------------------------------------------------------------------
ALTER TABLE "payout_beneficiaries"
  DROP COLUMN IF EXISTS "bachsDestinationId",
  DROP COLUMN IF EXISTS "bachsAccountId";

-- -----------------------------------------------------------------------------
-- payouts: paid from the merchant account to a bank account copied at request
-- time; the fee never leaves the merchant account, so nothing is settled.
-- -----------------------------------------------------------------------------
ALTER TABLE "payouts" RENAME COLUMN "feeSettlementKobo" TO "feeMarginKobo";
ALTER TABLE "payouts"
  DROP COLUMN IF EXISTS "destinationId",
  DROP COLUMN IF EXISTS "providerAccountId",
  DROP COLUMN IF EXISTS "feeSettledAt",
  ADD COLUMN "destinationBankCode" TEXT,
  ADD COLUMN "destinationAccount" TEXT;
ALTER TABLE "payouts" ALTER COLUMN "provider" SET DEFAULT 'kredi';

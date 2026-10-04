-- Payouts go to beneficiaries: any bank account the space chooses per
-- withdrawal (the rep's own, a lecturer's, a vendor's), replacing the single
-- saved account per space. No name-match rule, no 24-hour hold.

CREATE TABLE IF NOT EXISTS "payout_beneficiaries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "label" TEXT,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountNumberMasked" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "bachsDestinationId" TEXT,
    "bachsAccountId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_beneficiaries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payout_beneficiaries_spaceId_createdAt_idx" ON "payout_beneficiaries"("spaceId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "payout_beneficiaries" ADD CONSTRAINT "payout_beneficiaries_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "payouts"
  ADD COLUMN IF NOT EXISTS "beneficiaryId" TEXT,
  ADD COLUMN IF NOT EXISTS "accountName" TEXT,
  ADD COLUMN IF NOT EXISTS "destinationId" TEXT;

DO $$ BEGIN
  ALTER TABLE "payouts" ADD CONSTRAINT "payouts_beneficiaryId_fkey"
    FOREIGN KEY ("beneficiaryId") REFERENCES "payout_beneficiaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Carry each space's saved account over as its first beneficiary (same id),
-- and pin withdrawals still in flight to the destination they were meant for.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bank_accounts') THEN
    INSERT INTO "payout_beneficiaries"
      ("id", "spaceId", "bankCode", "bankName", "accountNumber", "accountNumberMasked", "accountName",
       "bachsDestinationId", "bachsAccountId", "createdAt", "updatedAt")
    SELECT "id", "spaceId", "bankCode", "bankName", "accountNumber", "accountNumberMasked", "accountName",
           "bachsDestinationId", "bachsAccountId", "setAt", "updatedAt"
    FROM "bank_accounts"
    ON CONFLICT ("id") DO NOTHING;

    UPDATE "payouts" p
       SET "beneficiaryId" = b."id",
           "accountName"   = b."accountName",
           "destinationId" = b."bachsDestinationId"
      FROM "bank_accounts" b
     WHERE b."spaceId" = p."spaceId"
       AND p."status" IN ('pending', 'processing')
       AND p."destinationId" IS NULL;

    DROP TABLE "bank_accounts";
  END IF;
END $$;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'beneficiary_added';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'beneficiary_removed';

-- KYC moves from BVN to NIN, plus Duevy's own review of the rep's student ID
-- card (stored in ImageKit; only the storage reference is kept here).

DO $$ BEGIN
  CREATE TYPE "DocumentReviewStatus" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "kycRequirementsDue" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "governmentIdSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "studentIdFileId" TEXT,
  ADD COLUMN IF NOT EXISTS "studentIdFilePath" TEXT,
  ADD COLUMN IF NOT EXISTS "studentIdMimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "studentIdStatus" "DocumentReviewStatus",
  ADD COLUMN IF NOT EXISTS "studentIdUploadedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "studentIdReviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "studentIdReviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "studentIdReviewNote" TEXT;

CREATE INDEX IF NOT EXISTS "users_studentIdStatus_idx" ON "users"("studentIdStatus");

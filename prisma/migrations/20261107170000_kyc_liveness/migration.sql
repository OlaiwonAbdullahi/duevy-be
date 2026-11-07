-- Liveness capture (photo or short video of the rep's face) for admin review.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessFileId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessFilePath" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessMimeType" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessStatus" "DocumentReviewStatus";
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessUploadedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessReviewedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessReviewedById" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "livenessReviewNote" TEXT;
CREATE INDEX IF NOT EXISTS "users_livenessStatus_idx" ON "users"("livenessStatus");

-- Reps already fully verified (NIN + student ID) when liveness was introduced
-- keep collecting: without this, requiring liveness would stop every live
-- space at deploy. Marked as such, so admins can tell and ask for a capture.
UPDATE "users"
   SET "livenessStatus" = 'approved',
       "livenessReviewedAt" = (now() AT TIME ZONE 'UTC'),
       "livenessReviewNote" = 'Verified before liveness checks were introduced; no capture on file.'
 WHERE "kycStatus" = 'verified' AND "studentIdStatus" = 'approved' AND "livenessStatus" IS NULL;

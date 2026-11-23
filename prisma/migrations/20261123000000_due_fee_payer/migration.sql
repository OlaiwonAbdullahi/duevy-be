-- Fee payer: a rep chooses, per due, whether the student pays the 1.5%
-- processing fee on top or the space absorbs it out of what it collects.

-- CreateEnum
CREATE TYPE "FeePayer" AS ENUM ('student', 'space');

-- AlterTable: the due's choice. Existing dues keep today's behaviour (student pays).
ALTER TABLE "dues" ADD COLUMN "feePayer" "FeePayer" NOT NULL DEFAULT 'student';

-- AlterTable: captured onto each checkout line so a paid checkout never changes.
-- Every existing line was paid under the student-pays model.
ALTER TABLE "checkout_items" ADD COLUMN "studentBearsFee" BOOLEAN NOT NULL DEFAULT true;

-- The student no longer always pays the fee on top, so totalKobo is no longer
-- exactly faceKobo + feeKobo. It now ranges from faceKobo (the space absorbs
-- every fee) up to faceKobo + feeKobo (the student bears every fee). The space
-- is credited totalKobo − feeKobo, which stays non-negative because feeKobo
-- (1.5% of face) never exceeds faceKobo.
ALTER TABLE "checkouts" DROP CONSTRAINT "checkouts_amounts_check";
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_amounts_check"
  CHECK ("faceKobo" >= 0 AND "feeKobo" >= 0 AND "totalKobo" >= "faceKobo" AND "totalKobo" <= "faceKobo" + "feeKobo");

-- Group checkouts: one payer can settle a due for several people, each a
-- distinct beneficiary with their own answers. Additive, plus a widening of the
-- (checkoutId, dueId) unique to include the beneficiary. Existing rows have
-- NULL beneficiaries and already satisfied the old 2-column unique.

-- AlterTable
ALTER TABLE "checkout_items"
  ADD COLUMN "beneficiaryUserId" TEXT,
  ADD COLUMN "guestAnswers" JSONB;

-- DropIndex (replaced by the 3-column unique below)
DROP INDEX IF EXISTS "checkout_items_checkoutId_dueId_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_items_checkoutId_dueId_beneficiaryUserId_key"
  ON "checkout_items"("checkoutId", "dueId", "beneficiaryUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "checkout_items_beneficiaryUserId_idx"
  ON "checkout_items"("beneficiaryUserId");

-- AddForeignKey
ALTER TABLE "checkout_items"
  ADD CONSTRAINT "checkout_items_beneficiaryUserId_fkey"
  FOREIGN KEY ("beneficiaryUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

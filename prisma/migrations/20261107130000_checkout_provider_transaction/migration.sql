-- The 9jaPay credit that paid a checkout. Account numbers are reused, so a
-- credit can fall inside two checkouts' windows; it may pay only one.
ALTER TABLE "checkouts" ADD COLUMN "providerTransactionId" TEXT;
CREATE UNIQUE INDEX "checkouts_providerTransactionId_key" ON "checkouts"("providerTransactionId");

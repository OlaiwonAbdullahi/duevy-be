-- Money sent straight to a space's own 9jaPay account (not through a
-- checkout) is credited to the space. Additive only.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'direct_deposit';

ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "walletDepositsCheckedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "direct_deposits" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "senderName" TEXT,
    "senderAccountNumber" TEXT,
    "senderBank" TEXT,
    "narration" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "direct_deposits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "direct_deposits_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "direct_deposits_providerTransactionId_key" ON "direct_deposits"("providerTransactionId");
CREATE INDEX IF NOT EXISTS "direct_deposits_spaceId_receivedAt_idx" ON "direct_deposits"("spaceId", "receivedAt");

ALTER TABLE "ledger_entries" ADD COLUMN IF NOT EXISTS "directDepositId" TEXT;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_directDepositId_fkey"
    FOREIGN KEY ("directDepositId") REFERENCES "direct_deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_entries_type_directDepositId_key" ON "ledger_entries"("type", "directDepositId");

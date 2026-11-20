-- Refunds: a rep sends a student's money back to the account they paid from.

-- A credit type that restores the space's balance when a refund fails.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'refund_reversal' AFTER 'refund';

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('pending', 'processing', 'success', 'failed', 'reversed');

-- AlterTable: link a ledger entry to the refund it records.
ALTER TABLE "ledger_entries" ADD COLUMN "refundId" TEXT;

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "duePaymentId" TEXT NOT NULL,
    "checkoutId" TEXT,
    "userId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'pending',
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT,
    "accountMasked" TEXT NOT NULL,
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'ninejapay',
    "providerRefundId" TEXT,
    "failureReason" TEXT,
    "processingAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refunds_reference_key" ON "refunds"("reference");
CREATE UNIQUE INDEX "refunds_providerRefundId_key" ON "refunds"("providerRefundId");
CREATE INDEX "refunds_spaceId_status_idx" ON "refunds"("spaceId", "status");
CREATE INDEX "refunds_duePaymentId_idx" ON "refunds"("duePaymentId");
CREATE INDEX "refunds_status_createdAt_idx" ON "refunds"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_type_refundId_key" ON "ledger_entries"("type", "refundId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "dues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_duePaymentId_fkey" FOREIGN KEY ("duePaymentId") REFERENCES "due_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

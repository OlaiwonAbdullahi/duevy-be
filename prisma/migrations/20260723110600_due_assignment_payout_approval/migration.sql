-- AlterTable
ALTER TABLE "dues" ADD COLUMN     "assignedRepId" TEXT;

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "dueId" TEXT,
ADD COLUMN     "requestedById" TEXT,
ALTER COLUMN "status" SET DEFAULT 'pending_approval';

-- AlterTable
ALTER TABLE "space_audit_logs" ADD COLUMN     "actorRole" "RepRole";

-- CreateTable
CREATE TABLE "payout_approvals" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "repUserId" TEXT NOT NULL,
    "decision" "PayoutApprovalDecision" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_approvals_payoutId_idx" ON "payout_approvals"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_approvals_payoutId_repUserId_key" ON "payout_approvals"("payoutId", "repUserId");

-- CreateIndex
CREATE INDEX "dues_assignedRepId_idx" ON "dues"("assignedRepId");

-- CreateIndex
CREATE INDEX "payouts_dueId_idx" ON "payouts"("dueId");

-- AddForeignKey
ALTER TABLE "dues" ADD CONSTRAINT "dues_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "dues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_approvals" ADD CONSTRAINT "payout_approvals_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_approvals" ADD CONSTRAINT "payout_approvals_repUserId_fkey" FOREIGN KEY ("repUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


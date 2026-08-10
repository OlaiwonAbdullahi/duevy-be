-- DropForeignKey
ALTER TABLE "cards" DROP CONSTRAINT "cards_userId_fkey";

-- DropIndex
DROP INDEX "spaces_paystackSubaccountCode_key";

-- AlterTable
ALTER TABLE "bank_accounts" DROP COLUMN "bankCodeGateway";

-- AlterTable — rename, not drop+add: preserves existing fee data (due_payments already has rows).
ALTER TABLE "due_payments" RENAME COLUMN "monnifyFee" TO "processingFee";
ALTER TABLE "due_payments"
  ADD COLUMN     "splitTransferId" TEXT,
  ADD COLUMN     "transferredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "spaces" DROP COLUMN "paystackSubaccountCode",
DROP COLUMN "subaccountGateway",
ADD COLUMN     "bachsAccountId" TEXT,
ADD COLUMN     "bachsPayoutDestinationId" TEXT,
ADD COLUMN     "bachsPayoutsActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bachsSetupStatus" TEXT,
ADD COLUMN     "bachsTransfersActive" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "app_settings";

-- DropTable
DROP TABLE "cards";

-- DropEnum
DROP TYPE "PaymentGatewayName";

-- CreateIndex
CREATE UNIQUE INDEX "spaces_bachsAccountId_key" ON "spaces"("bachsAccountId");

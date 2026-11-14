-- AlterTable: WhatsApp bot account link (E.164 digits), unique per account.
ALTER TABLE "users" ADD COLUMN "whatsappNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_whatsappNumber_key" ON "users"("whatsappNumber");

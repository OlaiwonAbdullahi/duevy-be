-- Reminder emails to rep applicants who haven't finished KYC (24h, 3d, 7d).
ALTER TABLE "users" ADD COLUMN "kycReminderStage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "kycReminderSentAt" TIMESTAMP(3);

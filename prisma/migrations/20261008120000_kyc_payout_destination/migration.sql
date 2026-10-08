-- The rep's own bank account, sent to Bachs as their account's
-- payout_destination during onboarding. Only the masked number is stored.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutDestinationBankCode" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutDestinationBankName" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutDestinationAccountMasked" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutDestinationAccountName" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutDestinationSubmittedAt" TIMESTAMP(3);

-- Bank78 replaces Bachs as the payment rail, and Didit takes over rep KYC.
--
-- Reps: a Bank78 sub-account (walletAccountNumber) replaces the Bachs Connect
-- account. Bachs account ids mean nothing to Bank78, so every rep verified on
-- Bachs goes back to unverified and redoes KYC (phone OTP + NIN with Didit).
-- Their student ID card review is kept: that is Duevy's own check.
ALTER TABLE "users" RENAME COLUMN "bachsAccountId" TO "walletAccountNumber";
ALTER INDEX "users_bachsAccountId_key" RENAME TO "users_walletAccountNumber_key";

UPDATE "users"
SET "walletAccountNumber" = NULL,
    "kycStatus" = 'unverified',
    "kycResolvedAt" = NULL,
    "kycRejectionReason" = NULL,
    "kycAttempts" = 0,
    "kycRetryLockedUntil" = NULL
WHERE "walletAccountNumber" IS NOT NULL OR "kycStatus" <> 'unverified';

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "bachsPersonId",
  DROP COLUMN IF EXISTS "bachsPayoutsActive",
  DROP COLUMN IF EXISTS "kycRequirementsDue",
  DROP COLUMN IF EXISTS "governmentIdSubmittedAt",
  DROP COLUMN IF EXISTS "payoutDestinationBankCode",
  DROP COLUMN IF EXISTS "payoutDestinationBankName",
  DROP COLUMN IF EXISTS "payoutDestinationAccountMasked",
  DROP COLUMN IF EXISTS "payoutDestinationAccountName",
  DROP COLUMN IF EXISTS "payoutDestinationSubmittedAt",
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "diditNinRequestId" TEXT;

-- Beneficiaries: the Bachs destination ids are dead; each is re-registered
-- against the lead rep's wallet at its next withdrawal.
ALTER TABLE "payout_beneficiaries" RENAME COLUMN "bachsDestinationId" TO "destinationId";
ALTER TABLE "payout_beneficiaries" RENAME COLUMN "bachsAccountId" TO "walletAccountNumber";
UPDATE "payout_beneficiaries" SET "destinationId" = NULL, "walletAccountNumber" = NULL;

-- Checkouts: no destination charge any more; a paid checkout's face amount is
-- routed into the lead rep's wallet, recorded here.
ALTER TABLE "checkouts"
  DROP COLUMN IF EXISTS "destinationAccountId",
  ADD COLUMN "routedAt" TIMESTAMP(3),
  ADD COLUMN "routeTransferId" TEXT;

ALTER TABLE "checkouts" ALTER COLUMN "provider" SET DEFAULT 'bank78';
ALTER TABLE "payouts" ALTER COLUMN "provider" SET DEFAULT 'bank78';
ALTER TABLE "webhook_events" ALTER COLUMN "provider" SET DEFAULT 'bank78';

-- The hosted/custom checkout switch is gone: Bank78 checkouts are always a
-- one-time bank account.
DELETE FROM "platform_settings" WHERE "key" = 'checkout_mode';

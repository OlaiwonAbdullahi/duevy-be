-- Bachs Connect -> Anchor (getanchor.co).
--
-- Provider columns are RENAMED rather than dropped and re-added wherever a
-- value carries over, so live financial rows survive the swap — the same
-- discipline the Paystack -> Bachs migration used for monnifyFee.
--
-- Two Space flags are genuinely dropped: bachsTransfersActive/bachsPayoutsActive
-- modelled Bachs's per-capability grants, which Anchor has no equivalent for.
-- Readiness under Anchor is "the customer passed KYC and the deposit account
-- exists", which is derivable from users.kycStatus + spaces.anchorAccountId.

-- ---------------------------------------------------------------------------
-- users — the rep is now the Anchor IndividualCustomer
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN     "anchorCustomerId" TEXT,
  ADD COLUMN     "kycSubmittedAt" TIMESTAMP(3),
  ADD COLUMN     "kycResolvedAt" TIMESTAMP(3),
  ADD COLUMN     "kycRejectionReason" TEXT,
  ADD COLUMN     "kycAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "kycRetryLockedUntil" TIMESTAMP(3),
  ADD COLUMN     "addressLine1" TEXT,
  ADD COLUMN     "addressLine2" TEXT,
  ADD COLUMN     "city" TEXT,
  ADD COLUMN     "state" TEXT,
  ADD COLUMN     "postalCode" TEXT;

CREATE UNIQUE INDEX "users_anchorCustomerId_key" ON "users"("anchorCustomerId");

-- ---------------------------------------------------------------------------
-- spaces — deposit account replaces the connected account
-- ---------------------------------------------------------------------------
DROP INDEX "spaces_bachsAccountId_key";

ALTER TABLE "spaces" RENAME COLUMN "bachsAccountId" TO "anchorAccountId";
ALTER TABLE "spaces" RENAME COLUMN "bachsSetupStatus" TO "anchorAccountStatus";
ALTER TABLE "spaces" RENAME COLUMN "bachsPayoutDestinationId" TO "anchorCounterPartyId";

ALTER TABLE "spaces"
  DROP COLUMN "bachsTransfersActive",
  DROP COLUMN "bachsPayoutsActive",
  ADD COLUMN     "anchorAccountNumber" TEXT,
  ADD COLUMN     "anchorBankName" TEXT;

-- Carried-over ids belong to Bachs and mean nothing to Anchor; blank them so a
-- space re-provisions cleanly instead of pointing at a dead account.
UPDATE "spaces"
   SET "anchorAccountId" = NULL,
       "anchorAccountStatus" = NULL,
       "anchorCounterPartyId" = NULL;

CREATE UNIQUE INDEX "spaces_anchorAccountId_key" ON "spaces"("anchorAccountId");

-- ---------------------------------------------------------------------------
-- due_payments — renamed for clarity, but the SEMANTIC IS UNCHANGED from the
-- Bachs era: money is collected centrally, then moved out to the department.
-- Under Anchor that second leg is a free book transfer from Duevy's settlement
-- account, so historical `transferredAt` rows carry over as-is.
-- ---------------------------------------------------------------------------
ALTER TABLE "due_payments" RENAME COLUMN "transferredAt" TO "remittedAt";
ALTER TABLE "due_payments" RENAME COLUMN "splitTransferId" TO "remitTransferId";

ALTER TABLE "due_payments"
  ADD COLUMN     "payWithTransferId" TEXT,
  ADD COLUMN     "checkoutAccountNumber" TEXT,
  ADD COLUMN     "checkoutExpiresAt" TIMESTAMP(3),
  ADD COLUMN     "settledAt" TIMESTAMP(3);

-- `settledAt` means "the provider confirmed the inflow into Duevy's collection
-- account". Anything already remitted to a department under the old model was,
-- by definition, collected first — so backfill it, or these rows would look
-- unsettled and a rep's withdrawable balance would silently reset to zero.
UPDATE "due_payments" SET "settledAt" = "paidAt" WHERE "remittedAt" IS NOT NULL;

-- `remitTransferId` deliberately keeps its historical Bachs ids rather than
-- being nulled: the transfer genuinely happened and is the only audit trail for
-- it. The column is provider-neutral for exactly this reason — do not rename it
-- to anchor*.

-- ---------------------------------------------------------------------------
-- payouts — PRD §7.3 fee breakdown
-- ---------------------------------------------------------------------------
ALTER TABLE "payouts"
  ADD COLUMN     "duevyFeeKobo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "anchorFeeKobo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "stampDutyKobo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "netSentKobo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "anchorTransferId" TEXT;

-- Historical payouts carried no fees: the full amount was sent.
UPDATE "payouts" SET "netSentKobo" = "amount" WHERE "netSentKobo" = 0;

-- ---------------------------------------------------------------------------
-- transactions — provider label
-- ---------------------------------------------------------------------------
UPDATE "transactions" SET "method" = 'Anchor' WHERE "method" = 'Bachs';

-- ---------------------------------------------------------------------------
-- webhook_events — the idempotency table (PRD §6.4)
-- ---------------------------------------------------------------------------
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "anchorEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_events_anchorEventId_key" ON "webhook_events"("anchorEventId");
CREATE INDEX "webhook_events_type_receivedAt_idx" ON "webhook_events"("type", "receivedAt");
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

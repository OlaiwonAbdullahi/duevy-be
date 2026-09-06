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
-- due_payments — the sweep inverts direction, so these columns change meaning
-- ---------------------------------------------------------------------------
ALTER TABLE "due_payments" RENAME COLUMN "transferredAt" TO "sweptAt";
ALTER TABLE "due_payments" RENAME COLUMN "splitTransferId" TO "anchorSweepTransferId";

ALTER TABLE "due_payments"
  ADD COLUMN     "virtualNubanId" TEXT,
  ADD COLUMN     "virtualAccountNumber" TEXT,
  ADD COLUMN     "virtualAccountExpiresAt" TIMESTAMP(3),
  ADD COLUMN     "settledAt" TIMESTAMP(3);

-- Historical payments were already transferred to the department under the old
-- model, so their funds are settled by definition. Without this they would drop
-- out of computeBalances()'s `available` (which now gates on settledAt) and a
-- rep's withdrawable balance would silently reset to zero.
UPDATE "due_payments" SET "settledAt" = "paidAt" WHERE "sweptAt" IS NOT NULL;

-- The old sweep moved the department's share INTO its account; the new one
-- moves Duevy's 2% OUT. Those are different operations, so historical rows are
-- reset to un-swept — but only the transfer id, not sweptAt: re-sweeping a
-- payment collected under the old fee model would take a cut that was never
-- charged. Leaving sweptAt set marks them as "nothing further to move".
UPDATE "due_payments" SET "anchorSweepTransferId" = NULL;

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

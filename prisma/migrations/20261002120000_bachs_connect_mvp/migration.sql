-- =============================================================================
-- Bachs Connect MVP: Anchor -> Bachs cutover.
--
-- Data-preserving. Anchor-era columns are kept (read-only) because a space may
-- still hold money in an Anchor deposit account that an admin has to trace and
-- pay out; nothing new writes them.
--
-- Defensive (IF EXISTS / IF NOT EXISTS) because 20260905120000_anchor was
-- edited after it had been applied in some environments.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Repair: the ledger (LedgerEntryType, LedgerDirection, ledger_entries) is in
-- the schema but was never in a migration - it reached existing databases via
-- `prisma db push`. Create it here if it is missing so a fresh database built
-- from migrations matches. A no-op where it already exists.
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "LedgerEntryType" AS ENUM ('due_payment', 'refund', 'payout', 'manual_credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LedgerDirection" AS ENUM ('credit', 'debit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ledger_entries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "dueId" TEXT,
    "txnId" TEXT,
    "duePaymentId" TEXT,
    "payoutId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "grossKobo" INTEGER,
    "feeKobo" INTEGER,
    "netKobo" INTEGER,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ledger_entries_spaceId_createdAt_idx" ON "ledger_entries"("spaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "ledger_entries_dueId_idx" ON "ledger_entries"("dueId");
CREATE INDEX IF NOT EXISTS "ledger_entries_reference_idx" ON "ledger_entries"("reference");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_spaceId_fkey') THEN
    ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_dueId_fkey') THEN
    ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "dues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_txnId_fkey') THEN
    ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_duePaymentId_fkey') THEN
    ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_duePaymentId_fkey" FOREIGN KEY ("duePaymentId") REFERENCES "due_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_payoutId_fkey') THEN
    ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- New enums
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "DueType" AS ENUM ('handout', 'departmental_due', 'exam_levy', 'lab_manual', 'association_due', 'departmental_wear', 'trip_fee', 'clearance', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CheckoutStatus" AS ENUM ('pending', 'paid', 'expired', 'underpaid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WebhookStatus" AS ENUM ('received', 'processing', 'processed', 'failed', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'payout_fee';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'payout_reversal';

-- -----------------------------------------------------------------------------
-- Users: additive rep permission, institution, Bachs identity
-- -----------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "isRep" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "institution" TEXT NOT NULL DEFAULT 'LAUTECH',
  ADD COLUMN IF NOT EXISTS "bachsAccountId" TEXT,
  ADD COLUMN IF NOT EXISTS "bachsPersonId" TEXT,
  ADD COLUMN IF NOT EXISTS "bachsPayoutsActive" BOOLEAN NOT NULL DEFAULT false;

-- Objects the edited Anchor migration may not have created everywhere.
DO $$ BEGIN
  CREATE TYPE "KycTier" AS ENUM ('tier_0', 'tier_2', 'tier_3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "kycTier" "KycTier" NOT NULL DEFAULT 'tier_0',
  ADD COLUMN IF NOT EXISTS "kycPendingTier" "KycTier";

UPDATE "users" SET "isRep" = true WHERE "role" = 'rep' OR "repApplicationStatus" = 'approved';

-- "verified" now means verified ON BACHS. Anchor verification does not carry
-- over, so every rep re-verifies once. kycTier keeps the Anchor-era record.
UPDATE "users" SET "kycStatus" = 'unverified', "kycAttempts" = 0, "kycRetryLockedUntil" = NULL
  WHERE "bachsAccountId" IS NULL AND "kycStatus" <> 'unverified';

CREATE UNIQUE INDEX IF NOT EXISTS "users_bachsAccountId_key" ON "users"("bachsAccountId");
CREATE INDEX IF NOT EXISTS "users_institution_idx" ON "users"("institution");

-- -----------------------------------------------------------------------------
-- Spaces: institution
-- -----------------------------------------------------------------------------
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "institution" TEXT NOT NULL DEFAULT 'LAUTECH';
CREATE INDEX IF NOT EXISTS "spaces_institution_idx" ON "spaces"("institution");

-- -----------------------------------------------------------------------------
-- Dues: DueCategory -> DueType, mapping the old values onto the new ones
-- -----------------------------------------------------------------------------
ALTER TABLE "dues" ALTER COLUMN "category" TYPE "DueType" USING (
  CASE "category"::text
    WHEN 'levy' THEN 'departmental_due'
    WHEN 'handout' THEN 'handout'
    ELSE 'other'
  END
)::"DueType";
DROP TYPE IF EXISTS "DueCategory";

-- -----------------------------------------------------------------------------
-- Payouts: new status model
--   pending_approval -> pending, completed -> success, cancelled -> failed
-- -----------------------------------------------------------------------------
ALTER TABLE "payouts"
  ADD COLUMN IF NOT EXISTS "feeKobo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "netKobo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "activeSpaceId" TEXT,
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'bachs',
  ADD COLUMN IF NOT EXISTS "providerPayoutId" TEXT,
  ADD COLUMN IF NOT EXISTS "providerAccountId" TEXT,
  ADD COLUMN IF NOT EXISTS "providerFeeKobo" INTEGER,
  ADD COLUMN IF NOT EXISTS "feeSettlementKobo" INTEGER,
  ADD COLUMN IF NOT EXISTS "feeSettledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);

-- Everything that exists before this migration went through Anchor. Tagging it
-- keeps the Bachs reconciliation job from ever touching it.
UPDATE "payouts" SET "provider" = 'anchor';

ALTER TABLE "payouts" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "PayoutStatus_new" AS ENUM ('pending', 'processing', 'success', 'failed', 'reversed');
ALTER TABLE "payouts" ALTER COLUMN "status" TYPE "PayoutStatus_new" USING (
  CASE "status"::text
    WHEN 'pending_approval' THEN 'pending'
    WHEN 'processing' THEN 'processing'
    WHEN 'completed' THEN 'success'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'failed'
  END
)::"PayoutStatus_new";
ALTER TYPE "PayoutStatus" RENAME TO "PayoutStatus_old";
ALTER TYPE "PayoutStatus_new" RENAME TO "PayoutStatus";
DROP TYPE "PayoutStatus_old";
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'pending';

-- Legacy split -> the new two-column split (amount = fee + net).
UPDATE "payouts"
  SET "netKobo" = "netSentKobo",
      "feeKobo" = "amount" - "netSentKobo"
  WHERE "netKobo" = 0 AND "netSentKobo" > 0;

-- The balance is now derived from the ledger, and a withdrawal is debited when
-- it is created rather than when it settles. Anchor-era payouts still in
-- flight were never debited, so debit them now; otherwise the same money would
-- show as available twice. (An admin resolves these against Anchor by hand.)
INSERT INTO "ledger_entries" ("id", "spaceId", "dueId", "payoutId", "type", "direction", "amountKobo", "grossKobo", "feeKobo", "netKobo", "reference", "description", "createdAt")
SELECT 'mig_' || p."id", p."spaceId", p."dueId", p."id", 'payout', 'debit', p."amount", p."amount", p."amount" - p."netSentKobo", p."netSentKobo",
       p."reference", 'Anchor-era payout in flight at the Bachs cutover', CURRENT_TIMESTAMP
FROM "payouts" p
WHERE p."status" IN ('pending', 'processing')
  AND NOT EXISTS (SELECT 1 FROM "ledger_entries" l WHERE l."payoutId" = p."id" AND l."type" = 'payout');

DROP INDEX IF EXISTS "payouts_spaceId_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_activeSpaceId_key" ON "payouts"("activeSpaceId");
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_providerPayoutId_key" ON "payouts"("providerPayoutId");
CREATE INDEX IF NOT EXISTS "payouts_spaceId_requestedAt_idx" ON "payouts"("spaceId", "requestedAt");
CREATE INDEX IF NOT EXISTS "payouts_status_requestedAt_idx" ON "payouts"("status", "requestedAt");

-- -----------------------------------------------------------------------------
-- Bank accounts: the destination registered on the rep's Bachs account
-- -----------------------------------------------------------------------------
ALTER TABLE "bank_accounts"
  ADD COLUMN IF NOT EXISTS "bachsDestinationId" TEXT,
  ADD COLUMN IF NOT EXISTS "bachsAccountId" TEXT;

-- -----------------------------------------------------------------------------
-- Webhook events: provider-neutral + DB-backed job queue
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS "webhook_events_anchorEventId_key";
DROP INDEX IF EXISTS "webhook_events_status_idx";

ALTER TABLE "webhook_events" RENAME COLUMN "anchorEventId" TO "providerEventId";
ALTER TABLE "webhook_events"
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'bachs',
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);
UPDATE "webhook_events" SET "provider" = 'anchor';

ALTER TABLE "webhook_events" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "webhook_events" ALTER COLUMN "status" TYPE "WebhookStatus" USING (
  CASE "status"
    WHEN 'processed' THEN 'processed'
    WHEN 'failed' THEN 'dead' -- Anchor events can no longer be reprocessed
    ELSE 'dead'
  END
)::"WebhookStatus";
ALTER TABLE "webhook_events" ALTER COLUMN "status" SET DEFAULT 'received';

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_provider_providerEventId_key" ON "webhook_events"("provider", "providerEventId");
CREATE INDEX IF NOT EXISTS "webhook_events_status_nextAttemptAt_idx" ON "webhook_events"("status", "nextAttemptAt");

-- -----------------------------------------------------------------------------
-- Idempotency keys: claim-before-run + request fingerprint
-- -----------------------------------------------------------------------------
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "requestHash" TEXT;
ALTER TABLE "idempotency_keys" ALTER COLUMN "responseBody" DROP NOT NULL;

-- -----------------------------------------------------------------------------
-- Checkouts, items, receipts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "checkouts" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'pending',
    "faceKobo" INTEGER NOT NULL,
    "feeKobo" INTEGER NOT NULL,
    "totalKobo" INTEGER NOT NULL,
    "receivedKobo" INTEGER,
    "overpaidKobo" INTEGER NOT NULL DEFAULT 0,
    "dueSetKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'bachs',
    "providerCheckoutId" TEXT,
    "providerChargeId" TEXT,
    "destinationAccountId" TEXT,
    "vaAccountNumber" TEXT,
    "vaBankName" TEXT,
    "vaAccountName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "underpaidAt" TIMESTAMP(3),
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "checkouts_amounts_check" CHECK ("faceKobo" >= 0 AND "feeKobo" >= 0 AND "totalKobo" = "faceKobo" + "feeKobo")
);

CREATE TABLE IF NOT EXISTS "checkout_items" (
    "id" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "faceKobo" INTEGER NOT NULL,
    "feeKobo" INTEGER NOT NULL,
    CONSTRAINT "checkout_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "receipts" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "totalKobo" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "checkouts_reference_key" ON "checkouts"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "checkouts_providerCheckoutId_key" ON "checkouts"("providerCheckoutId");
CREATE INDEX IF NOT EXISTS "checkouts_userId_status_idx" ON "checkouts"("userId", "status");
CREATE INDEX IF NOT EXISTS "checkouts_spaceId_status_idx" ON "checkouts"("spaceId", "status");
CREATE INDEX IF NOT EXISTS "checkouts_status_expiresAt_idx" ON "checkouts"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "checkouts_needsReview_idx" ON "checkouts"("needsReview");
CREATE INDEX IF NOT EXISTS "checkout_items_dueId_idx" ON "checkout_items"("dueId");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_items_checkoutId_dueId_key" ON "checkout_items"("checkoutId", "dueId");
CREATE UNIQUE INDEX IF NOT EXISTS "receipts_number_key" ON "receipts"("number");
CREATE UNIQUE INDEX IF NOT EXISTS "receipts_checkoutId_key" ON "receipts"("checkoutId");
CREATE INDEX IF NOT EXISTS "receipts_userId_issuedAt_idx" ON "receipts"("userId", "issuedAt");

ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkout_items" ADD CONSTRAINT "checkout_items_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "checkouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_items" ADD CONSTRAINT "checkout_items_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "dues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Due payments: link to the checkout that settled them
-- -----------------------------------------------------------------------------
ALTER TABLE "due_payments" ADD COLUMN IF NOT EXISTS "checkoutId" TEXT;
CREATE INDEX IF NOT EXISTS "due_payments_checkoutId_idx" ON "due_payments"("checkoutId");
ALTER TABLE "due_payments" ADD CONSTRAINT "due_payments_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "checkouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Ledger: idempotency keys, positive amounts, append-only
-- -----------------------------------------------------------------------------
-- If either index fails to build, the ledger already holds a duplicate from
-- before this migration; resolve it by hand rather than weakening the key.
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_entries_type_duePaymentId_key" ON "ledger_entries"("type", "duePaymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_entries_type_payoutId_key" ON "ledger_entries"("type", "payoutId");

ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_amount_positive";
-- NOT VALID: enforced for every new row without failing on historical ones.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amountKobo" > 0) NOT VALID;

CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_no_update ON "ledger_entries";
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();

DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON "ledger_entries";
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only();

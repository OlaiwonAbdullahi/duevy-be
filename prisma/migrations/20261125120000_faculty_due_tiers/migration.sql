-- Faculty collections, first cut: variable / tiered due amounts.
--
-- A `tiered` due offers several priced options (DueTier); the payer picks one at
-- checkout and is charged its amountKobo. The chosen tier is snapshotted onto
-- the checkout line (checkout_items.tierId + tierLabel) alongside faceKobo, so a
-- later edit or archival of the tier never changes what a paid line cost.
--
-- All additive: existing dues default to `flat`, existing checkout lines keep a
-- NULL tier. No backfill.

-- CreateEnum
CREATE TYPE "DuePricing" AS ENUM ('flat', 'tiered');

-- AlterTable: dues
ALTER TABLE "dues"
  ADD COLUMN "pricingMode" "DuePricing" NOT NULL DEFAULT 'flat';

-- CreateTable: due_tiers
CREATE TABLE "due_tiers" (
    "id" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "due_tiers_pkey" PRIMARY KEY ("id")
);

-- AlterTable: checkout_items
ALTER TABLE "checkout_items"
  ADD COLUMN "tierId" TEXT,
  ADD COLUMN "tierLabel" TEXT;

-- CreateIndex
CREATE INDEX "due_tiers_dueId_idx" ON "due_tiers"("dueId");
CREATE INDEX "checkout_items_tierId_idx" ON "checkout_items"("tierId");

-- AddForeignKey
ALTER TABLE "due_tiers"
  ADD CONSTRAINT "due_tiers_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "dues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_items"
  ADD CONSTRAINT "checkout_items_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "due_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-space override of the collection fee rate, in basis points. NULL keeps a
-- space on the default COLLECTION_FEE_BPS (150 = 1.5%). Set for special-rate
-- spaces, e.g. a founding rep's department at 130 (1.3%). The override feeds the
-- stored feeKobo before the feePayer split, so it holds whether the student pays
-- the fee on top or the space absorbs it.

-- AlterTable: existing spaces keep the default rate (NULL).
ALTER TABLE "spaces" ADD COLUMN "collectionFeeBps" INTEGER;

-- A rate can't be negative; 0 (fee-free) up to 10000 (100%) is the sane range.
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_collection_fee_bps_check"
  CHECK ("collectionFeeBps" IS NULL OR ("collectionFeeBps" >= 0 AND "collectionFeeBps" <= 10000));

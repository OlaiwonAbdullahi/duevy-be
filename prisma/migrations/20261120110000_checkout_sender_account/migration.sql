-- Capture the payer's source account on a paid checkout, so a rep can refund
-- the money back to the same account. Null on existing rows (not refundable to
-- source) and on any payment the rail doesn't report a sender for.
ALTER TABLE "checkouts"
  ADD COLUMN "senderName" TEXT,
  ADD COLUMN "senderAccountNumber" TEXT,
  ADD COLUMN "senderBank" TEXT,
  ADD COLUMN "senderBankCode" TEXT;

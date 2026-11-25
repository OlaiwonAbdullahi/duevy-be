-- Mark when the abandoned-checkout reminder email has been sent for a pending
-- checkout, so the sweep (jobs/abandonedCheckouts.ts) nudges each payer once.
-- Null on existing rows: none have been reminded yet.
ALTER TABLE "checkouts"
  ADD COLUMN "abandonedReminderSentAt" TIMESTAMP(3);

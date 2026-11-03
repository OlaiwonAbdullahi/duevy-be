-- Guest checkout account opt-in: when the guest asked for a Duevy account, and
-- when its activation link was sent (only ever after the checkout is paid).
ALTER TABLE "checkouts" ADD COLUMN "accountRequestedAt" TIMESTAMP(3);
ALTER TABLE "checkouts" ADD COLUMN "accountInviteSentAt" TIMESTAMP(3);
CREATE INDEX "checkouts_status_accountRequestedAt_idx" ON "checkouts"("status", "accountRequestedAt");

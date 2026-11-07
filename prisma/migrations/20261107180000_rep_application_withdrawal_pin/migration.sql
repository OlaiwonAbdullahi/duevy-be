-- Withdrawal code chosen at rep signup; copied onto the space on approval.
ALTER TABLE "rep_applications" ADD COLUMN IF NOT EXISTS "withdrawalPinHash" TEXT;

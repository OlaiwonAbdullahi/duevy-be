-- Partners (SUG, NACOS, …): a partner code entered at rep signup, or applied
-- later by the lead rep, discounts the space's withdrawal fees.
ALTER TYPE "AuditAction" ADD VALUE 'partner_applied';

CREATE TYPE "PartnerRedemptionSource" AS ENUM ('signup', 'settings', 'admin');

CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "logoUrl" TEXT,
    "withdrawalFeeDiscountPercent" INTEGER NOT NULL,
    "durationDays" INTEGER,
    "maxRedemptions" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "partners_discount_range" CHECK ("withdrawalFeeDiscountPercent" BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX "partners_code_key" ON "partners"("code");

-- One partner per space; percent and end date are fixed at redemption.
CREATE TABLE "partner_redemptions" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "redeemedById" TEXT,
    "source" "PartnerRedemptionSource" NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "endsAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_redemptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_redemptions_spaceId_key" ON "partner_redemptions"("spaceId");
CREATE INDEX "partner_redemptions_partnerId_idx" ON "partner_redemptions"("partnerId");
ALTER TABLE "partner_redemptions" ADD CONSTRAINT "partner_redemptions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_redemptions" ADD CONSTRAINT "partner_redemptions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_redemptions" ADD CONSTRAINT "partner_redemptions_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rep_applications" ADD COLUMN "partnerCode" TEXT;

-- The partner discount already taken off feeKobo, and where it came from.
ALTER TABLE "payouts" ADD COLUMN "feeDiscountKobo" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payouts" ADD COLUMN "partnerRedemptionId" TEXT;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_partnerRedemptionId_fkey" FOREIGN KEY ("partnerRedemptionId") REFERENCES "partner_redemptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

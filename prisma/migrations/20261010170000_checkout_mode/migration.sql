-- Hosted checkout: the provider page the student is redirected to.
ALTER TABLE "checkouts" ADD COLUMN "checkoutUrl" TEXT;

-- Platform-wide settings an admin can change at runtime (e.g. checkout_mode).
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

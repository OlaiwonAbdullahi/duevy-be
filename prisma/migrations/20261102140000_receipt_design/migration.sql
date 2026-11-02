-- Custom receipts: one design per space — colour, wording, logo and signature.
CREATE TABLE "receipt_designs" (
    "spaceId" TEXT NOT NULL,
    "accent" TEXT,
    "headerStyle" TEXT NOT NULL DEFAULT 'artwork',
    "title" TEXT,
    "showStamp" BOOLEAN NOT NULL DEFAULT true,
    "stampText" TEXT,
    "thankYou" TEXT,
    "note" TEXT,
    "showAnswers" BOOLEAN NOT NULL DEFAULT true,
    "signatureName" TEXT,
    "signatureRole" TEXT,
    "logo" BYTEA,
    "logoMime" TEXT,
    "signature" BYTEA,
    "signatureMime" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_designs_pkey" PRIMARY KEY ("spaceId")
);

ALTER TABLE "receipt_designs" ADD CONSTRAINT "receipt_designs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

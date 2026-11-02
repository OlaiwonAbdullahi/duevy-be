-- Receipts can carry several signatures (up to three), each with its own
-- name, role and image. Moves any single signature already saved on a design
-- into the new table, then drops the old columns.
CREATE TABLE "receipt_signatures" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT,
    "role" TEXT,
    "image" BYTEA,
    "imageMime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_signatures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receipt_signatures_spaceId_position_idx" ON "receipt_signatures"("spaceId", "position");

ALTER TABLE "receipt_signatures" ADD CONSTRAINT "receipt_signatures_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "receipt_designs"("spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "receipt_signatures" ("id", "spaceId", "position", "name", "role", "image", "imageMime")
SELECT 'sig_' || md5(random()::text || "spaceId"), "spaceId", 0, "signatureName", "signatureRole", "signature", "signatureMime"
FROM "receipt_designs"
WHERE "signature" IS NOT NULL OR "signatureName" IS NOT NULL OR "signatureRole" IS NOT NULL;

ALTER TABLE "receipt_designs"
    DROP COLUMN "signature",
    DROP COLUMN "signatureMime",
    DROP COLUMN "signatureName",
    DROP COLUMN "signatureRole";

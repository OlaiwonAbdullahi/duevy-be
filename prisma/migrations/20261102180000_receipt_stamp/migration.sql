-- Receipt stamp options: a shape, its own colour, or the space's own stamp image.
ALTER TABLE "receipt_designs"
    ADD COLUMN "stampStyle" TEXT NOT NULL DEFAULT 'round',
    ADD COLUMN "stampColor" TEXT,
    ADD COLUMN "stampImage" BYTEA,
    ADD COLUMN "stampMime" TEXT;

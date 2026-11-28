-- CreateTable
CREATE TABLE "status_checks" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_checks_service_checkedAt_idx" ON "status_checks"("service", "checkedAt");

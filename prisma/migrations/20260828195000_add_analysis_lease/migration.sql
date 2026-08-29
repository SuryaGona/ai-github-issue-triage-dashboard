ALTER TABLE "ImportJob"
ADD COLUMN "analysisLeaseId" TEXT,
ADD COLUMN "analysisStartedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ImportJob_analysisLeaseId_key"
ON "ImportJob"("analysisLeaseId");
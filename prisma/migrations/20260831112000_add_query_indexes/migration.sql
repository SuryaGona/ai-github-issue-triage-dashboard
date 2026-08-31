CREATE INDEX "Issue_repositoryId_importedAt_idx"
ON "Issue"("repositoryId", "importedAt" DESC);

CREATE INDEX "Issue_repositoryId_createdAtGithub_issueNumber_idx"
ON "Issue"("repositoryId", "createdAtGithub" DESC, "issueNumber" DESC);

CREATE INDEX "ImportJob_repositoryId_status_analysisStartedAt_idx"
ON "ImportJob"("repositoryId", "status", "analysisStartedAt");

CREATE INDEX "ImportJob_startedAt_idx"
ON "ImportJob"("startedAt");

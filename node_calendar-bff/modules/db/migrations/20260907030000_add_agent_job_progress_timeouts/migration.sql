ALTER TABLE "AgentJob"
ADD COLUMN "progressUpdatedAt" TIMESTAMP(3),
ADD COLUMN "maxExecutionMs" INTEGER;

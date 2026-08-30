ALTER TABLE "AgentJob" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "AgentJob" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

ALTER TABLE "AgentJobEvent" ADD COLUMN "level" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "AgentJobEvent" ADD COLUMN "traceId" TEXT;
ALTER TABLE "AgentJobEvent" ADD COLUMN "parentEventId" TEXT;
ALTER TABLE "AgentJobEvent" ADD COLUMN "durationMs" INTEGER;

CREATE UNIQUE INDEX "AgentJob_userId_idempotencyKey_key" ON "AgentJob"("userId", "idempotencyKey");
CREATE INDEX "AgentJobEvent_traceId_idx" ON "AgentJobEvent"("traceId");

CREATE TABLE "AgentCompensation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "reason" TEXT,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCompensation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentCompensation_userId_createdAt_idx" ON "AgentCompensation"("userId", "createdAt");
CREATE INDEX "AgentCompensation_runId_idx" ON "AgentCompensation"("runId");

ALTER TABLE "AgentCompensation" ADD CONSTRAINT "AgentCompensation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stepId" TEXT,
    "message" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentJobEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentCheckpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB,
    "resumePayload" JSONB,
    "stateSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentJob_userId_createdAt_idx" ON "AgentJob"("userId", "createdAt");
CREATE INDEX "AgentJob_runId_idx" ON "AgentJob"("runId");
CREATE INDEX "AgentJob_status_priority_createdAt_idx" ON "AgentJob"("status", "priority", "createdAt");
CREATE INDEX "AgentJob_lockedAt_idx" ON "AgentJob"("lockedAt");

CREATE INDEX "AgentJobEvent_jobId_createdAt_idx" ON "AgentJobEvent"("jobId", "createdAt");

CREATE INDEX "AgentCheckpoint_runId_status_idx" ON "AgentCheckpoint"("runId", "status");
CREATE INDEX "AgentCheckpoint_userId_status_createdAt_idx" ON "AgentCheckpoint"("userId", "status", "createdAt");
CREATE INDEX "AgentCheckpoint_expiresAt_idx" ON "AgentCheckpoint"("expiresAt");

ALTER TABLE "AgentJob" ADD CONSTRAINT "AgentJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentJobEvent" ADD CONSTRAINT "AgentJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentCheckpoint" ADD CONSTRAINT "AgentCheckpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

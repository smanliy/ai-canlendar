CREATE TABLE "ScheduleOperationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "jobId" TEXT,
    "operateType" TEXT NOT NULL,
    "targetScheduleId" TEXT NOT NULL,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "isCompensated" BOOLEAN NOT NULL DEFAULT false,
    "compensatedAt" TIMESTAMP(3),
    "compensationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleOperationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduleOperationLog_userId_taskId_createdAt_idx" ON "ScheduleOperationLog"("userId", "taskId", "createdAt");
CREATE INDEX "ScheduleOperationLog_taskId_isCompensated_createdAt_idx" ON "ScheduleOperationLog"("taskId", "isCompensated", "createdAt");
CREATE INDEX "ScheduleOperationLog_targetScheduleId_idx" ON "ScheduleOperationLog"("targetScheduleId");

ALTER TABLE "ScheduleOperationLog" ADD CONSTRAINT "ScheduleOperationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

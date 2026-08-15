-- CreateTable
CREATE TABLE "AgentPlanningSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawInput" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waitingConfirm',
    "userPreference" JSONB NOT NULL,
    "normalizedContext" JSONB NOT NULL,
    "atomicPlan" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlanningSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPlanningSession_userId_idx" ON "AgentPlanningSession"("userId");

-- CreateIndex
CREATE INDEX "AgentPlanningSession_userId_updatedAt_idx" ON "AgentPlanningSession"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "AgentPlanningSession" ADD CONSTRAINT "AgentPlanningSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

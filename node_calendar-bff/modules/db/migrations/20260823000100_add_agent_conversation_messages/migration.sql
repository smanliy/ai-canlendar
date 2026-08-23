-- CreateTable
CREATE TABLE "AgentConversationMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "runId" TEXT,
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + '30 days'::interval),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AgentConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConversationMessage_userId_createdAt_idx" ON "AgentConversationMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentConversationMessage_userId_expiresAt_idx" ON "AgentConversationMessage"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentConversationMessage_runId_idx" ON "AgentConversationMessage"("runId");

-- AddForeignKey
ALTER TABLE "AgentConversationMessage" ADD CONSTRAINT "AgentConversationMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

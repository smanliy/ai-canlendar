import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prisma } from '../db/prisma';

export interface SaveAgentConversationMessageInput {
  role: string;
  kind: string;
  content: string;
  runId?: string;
  payload?: unknown;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}

function toJsonString(value: unknown): string | null {
  const json = toJson(value);
  return json === undefined ? null : JSON.stringify(json);
}

interface AgentConversationMessageRecord {
  id: string;
  userId: string;
  role: string;
  kind: string;
  content: string;
  runId: string | null;
  payload: unknown;
  expiresAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
}

export function listRecentConversationMessages(userId: string, limit = 80) {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  return prisma.$queryRaw<AgentConversationMessageRecord[]>`
    SELECT
      "id",
      "userId",
      "role",
      "kind",
      "content",
      "runId",
      "payload",
      "expiresAt",
      "createdAt",
      "deletedAt"
    FROM "AgentConversationMessage"
    WHERE "userId" = ${userId}
      AND "deletedAt" IS NULL
      AND "expiresAt" > now()
    ORDER BY "createdAt" ASC
    LIMIT ${safeLimit}
  `;
}

export function saveConversationMessage(userId: string, input: SaveAgentConversationMessageInput) {
  const id = randomUUID();
  const payloadJson = toJsonString(input.payload);
  return prisma.$queryRaw<AgentConversationMessageRecord[]>`
    INSERT INTO "AgentConversationMessage" ("id", "userId", "role", "kind", "content", "runId", "payload")
    VALUES (${id}, ${userId}, ${input.role}, ${input.kind}, ${input.content}, ${input.runId ?? null}, ${payloadJson}::jsonb)
    RETURNING
      "id",
      "userId",
      "role",
      "kind",
      "content",
      "runId",
      "payload",
      "expiresAt",
      "createdAt",
      "deletedAt"
  `.then((rows) => rows[0]);
}

export function clearConversationMessages(userId: string) {
  return prisma.$executeRaw`
    UPDATE "AgentConversationMessage"
    SET "deletedAt" = now()
    WHERE "userId" = ${userId}
      AND "deletedAt" IS NULL
  `;
}

export function deleteExpiredConversationMessages() {
  return prisma.$executeRaw`
    DELETE FROM "AgentConversationMessage"
    WHERE "expiresAt" < now()
  `;
}

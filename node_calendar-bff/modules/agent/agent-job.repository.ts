import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prisma } from '../db/prisma';

export type AgentJobType = 'schedule_plan' | 'resume_decision' | 'annotate_plan';
export type AgentJobStatus = 'queued' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'canceled';

export interface AgentJobRecord {
  id: string;
  runId: string;
  userId: string;
  type: AgentJobType;
  status: AgentJobStatus;
  idempotencyKey: string | null;
  input: unknown;
  result: unknown | null;
  error: string | null;
  priority: number;
  attempt: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentJobEventRecord {
  id: string;
  jobId: string;
  type: string;
  stepId: string | null;
  message: string | null;
  payload: unknown | null;
  level: string;
  traceId: string | null;
  parentEventId: string | null;
  durationMs: number | null;
  createdAt: Date;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function toJsonString(value: unknown): string {
  return JSON.stringify(toJson(value));
}

function normalizeJob(row: AgentJobRecord): AgentJobRecord {
  return row;
}

export async function createAgentJob(input: {
  userId: string;
  runId?: string;
  type: AgentJobType;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
}): Promise<AgentJobRecord> {
  const runId = input.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (input.idempotencyKey) {
    const existingRows = await prisma.$queryRaw<AgentJobRecord[]>`
      SELECT *
      FROM "AgentJob"
      WHERE "userId" = ${input.userId}
        AND "idempotencyKey" = ${input.idempotencyKey}
        AND "status" IN ('queued', 'running', 'waiting_user', 'succeeded')
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (existing) return normalizeJob(existing as AgentJobRecord);
  }

  const id = randomUUID();
  const payloadJson = toJsonString(input.payload);
  const rows = await prisma.$queryRaw<AgentJobRecord[]>`
    INSERT INTO "AgentJob" ("id", "runId", "userId", "type", "status", "idempotencyKey", "input", "priority", "maxAttempts", "updatedAt")
    VALUES (${id}, ${runId}, ${input.userId}, ${input.type}, 'queued', ${input.idempotencyKey ?? null}, ${payloadJson}::jsonb, ${input.priority ?? 0}, ${input.maxAttempts ?? 3}, now())
    RETURNING *
  `;
  const row = rows[0];
  return normalizeJob(row as AgentJobRecord);
}

export async function claimNextAgentJob(workerId: string): Promise<AgentJobRecord | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<AgentJobRecord[]>`
      SELECT *
      FROM "AgentJob"
      WHERE "status" = 'queued'
      ORDER BY "priority" DESC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const job = rows[0];
    if (!job) return null;

    const updatedRows = await tx.$queryRaw<AgentJobRecord[]>`
      UPDATE "AgentJob"
      SET "status" = 'running',
          "attempt" = "attempt" + 1,
          "lockedAt" = now(),
          "lockedBy" = ${workerId},
          "heartbeatAt" = now(),
          "startedAt" = COALESCE("startedAt", now()),
          "error" = NULL,
          "updatedAt" = now()
      WHERE "id" = ${job.id}
      RETURNING *
    `;
    const updated = updatedRows[0];
    return normalizeJob(updated as AgentJobRecord);
  });
}

export async function findAgentJob(jobId: string, userId: string): Promise<AgentJobRecord | null> {
  const rows = await prisma.$queryRaw<AgentJobRecord[]>`
    SELECT *
    FROM "AgentJob"
    WHERE "id" = ${jobId}
      AND "userId" = ${userId}
    LIMIT 1
  `;
  const job = rows[0];
  return job ? normalizeJob(job as AgentJobRecord) : null;
}

export async function listAgentJobs(userId: string, limit = 30): Promise<AgentJobRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const jobs = await prisma.$queryRaw<AgentJobRecord[]>`
    SELECT *
    FROM "AgentJob"
    WHERE "userId" = ${userId}
    ORDER BY "createdAt" DESC
    LIMIT ${safeLimit}
  `;
  return jobs.map((job) => normalizeJob(job as AgentJobRecord));
}

export async function completeAgentJob(jobId: string, result: unknown, status: 'succeeded' | 'waiting_user' = 'succeeded'): Promise<void> {
  const resultJson = toJsonString(result);
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = ${status},
        "result" = ${resultJson}::jsonb,
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "finishedAt" = CASE WHEN ${status} = 'succeeded' THEN now() ELSE NULL END,
        "updatedAt" = now()
    WHERE "id" = ${jobId}
  `;
}

export async function updateAgentJobRunId(jobId: string, runId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "runId" = ${runId},
        "updatedAt" = now()
    WHERE "id" = ${jobId}
  `;
}

export async function failAgentJob(job: AgentJobRecord, error: string): Promise<void> {
  const retry = job.attempt < job.maxAttempts;
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = ${retry ? 'queued' : 'failed'},
        "error" = ${error},
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "finishedAt" = CASE WHEN ${retry} THEN NULL ELSE now() END,
        "updatedAt" = now()
    WHERE "id" = ${job.id}
  `;
}

export async function cancelAgentJob(jobId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "userId" = ${userId}
      AND "status" IN ('queued', 'running', 'waiting_user')
  `;
}

export async function cancelAgentJobById(jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "status" IN ('queued', 'running', 'waiting_user')
  `;
}

export async function cancelActiveAgentJobsByUser(userId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "userId" = ${userId}
      AND "status" IN ('queued', 'running', 'waiting_user')
  `;
}

export async function appendAgentJobEvent(input: {
  jobId: string;
  type: string;
  stepId?: string;
  message?: string;
  payload?: unknown;
  level?: 'info' | 'warn' | 'error';
  traceId?: string;
  parentEventId?: string;
  durationMs?: number;
}): Promise<AgentJobEventRecord> {
  const id = randomUUID();
  const payloadJson = input.payload === undefined ? null : toJsonString(input.payload);
  const rows = await prisma.$queryRaw<AgentJobEventRecord[]>`
    INSERT INTO "AgentJobEvent" ("id", "jobId", "type", "level", "stepId", "message", "payload", "traceId", "parentEventId", "durationMs")
    VALUES (${id}, ${input.jobId}, ${input.type}, ${input.level ?? 'info'}, ${input.stepId ?? null}, ${input.message ?? null}, ${payloadJson}::jsonb, ${input.traceId ?? null}, ${input.parentEventId ?? null}, ${input.durationMs ?? null})
    RETURNING *
  `;
  const event = rows[0];
  return event as AgentJobEventRecord;
}

export async function listAgentJobEvents(jobId: string, after?: Date, limit = 200): Promise<AgentJobEventRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  if (after) {
    return prisma.$queryRaw<AgentJobEventRecord[]>`
      SELECT *
      FROM "AgentJobEvent"
      WHERE "jobId" = ${jobId}
        AND "createdAt" > ${after}
      ORDER BY "createdAt" ASC
      LIMIT ${safeLimit}
    `;
  }
  return prisma.$queryRaw<AgentJobEventRecord[]>`
    SELECT *
    FROM "AgentJobEvent"
    WHERE "jobId" = ${jobId}
    ORDER BY "createdAt" ASC
    LIMIT ${safeLimit}
  `;
}

export async function heartbeatAgentJob(jobId: string, workerId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "heartbeatAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "lockedBy" = ${workerId}
      AND "status" = 'running'
  `;
}

export async function recoverStaleAgentJobs(staleBefore: Date): Promise<number> {
  const failed = await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'failed',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "finishedAt" = now(),
        "error" = 'Worker heartbeat timed out; retry limit reached',
        "updatedAt" = now()
    WHERE "status" = 'running'
      AND "attempt" >= "maxAttempts"
      AND ("heartbeatAt" IS NULL OR "heartbeatAt" < ${staleBefore})
  `;
  const requeued = await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'queued',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "error" = 'Worker heartbeat timed out; job was requeued',
        "updatedAt" = now()
    WHERE "status" = 'running'
      AND "attempt" < "maxAttempts"
      AND ("heartbeatAt" IS NULL OR "heartbeatAt" < ${staleBefore})
  `;
  return failed + requeued;
}

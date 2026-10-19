import type { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

import { prisma } from "../db/prisma";

export type AgentJobType =
  | "schedule_plan"
  | "resume_decision"
  | "annotate_plan";
export type AgentJobStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "canceled"
  | "abandoned";

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
  progressUpdatedAt: Date | null;
  maxExecutionMs: number | null;
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

function defaultMaxExecutionMs(type: AgentJobType): number {
  if (type === "schedule_plan") return 30 * 60 * 1000;
  if (type === "resume_decision") return 10 * 60 * 1000;
  if (type === "annotate_plan") return 10 * 60 * 1000;
  return 30 * 60 * 1000;
}

export async function createAgentJob(input: {
  userId: string;
  runId?: string;
  type: AgentJobType;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  maxExecutionMs?: number;
  idempotencyKey?: string;
}): Promise<AgentJobRecord> {
  const runId = input.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (input.idempotencyKey) {
    const existingRows = await prisma.$queryRaw<AgentJobRecord[]>`
      SELECT *
      FROM "AgentJob"
      WHERE "userId" = ${input.userId}
        AND "idempotencyKey" = ${input.idempotencyKey}
        AND "status" IN ('queued', 'running', 'waiting_user')
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (existing) return normalizeJob(existing as AgentJobRecord);
  }

  const id = randomUUID();
  const payloadJson = toJsonString(input.payload);
  const maxExecutionMs =
    input.maxExecutionMs ?? defaultMaxExecutionMs(input.type);
  const rows = await prisma.$queryRaw<AgentJobRecord[]>`
    INSERT INTO "AgentJob" ("id", "runId", "userId", "type", "status", "idempotencyKey", "input", "priority", "maxAttempts", "maxExecutionMs", "updatedAt")
    VALUES (${id}, ${runId}, ${input.userId}, ${input.type}, 'queued', ${input.idempotencyKey ?? null}, ${payloadJson}::jsonb, ${input.priority ?? 0}, ${input.maxAttempts ?? 3}, ${maxExecutionMs}, now())
    RETURNING *
  `;
  const row = rows[0];
  return normalizeJob(row as AgentJobRecord);
}

export async function claimNextAgentJob(
  workerId: string,
): Promise<AgentJobRecord | null> {
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
          "progressUpdatedAt" = now(),
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

export async function findAgentJob(
  jobId: string,
  userId: string,
): Promise<AgentJobRecord | null> {
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

export async function listAgentJobs(
  userId: string,
  limit = 30,
): Promise<AgentJobRecord[]> {
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

export async function listAgentJobsByStatus(
  userId: string,
  statuses: AgentJobStatus[],
): Promise<AgentJobRecord[]> {
  if (statuses.length === 0) return [];
  const jobs = await prisma.agentJob.findMany({
    where: {
      userId,
      status: { in: statuses }
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  return jobs.map((job) => normalizeJob(job as unknown as AgentJobRecord));
}

/**
 * 物理删除任务：级联删除事件表、该 run 的全部 checkpoint，最后删任务行本身。
 * 仅用于异常退出清理（用户已确认物理删除语义）。waiting_user / paused_manual 任务不得走此路径。
 */
export async function hardDeleteAgentJob(jobId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.$queryRaw<AgentJobRecord[]>`
      SELECT * FROM "AgentJob"
      WHERE "id" = ${jobId} AND "userId" = ${userId}
      LIMIT 1
    `;
    const row = job[0];
    if (!row) return false;

    await tx.$executeRaw`DELETE FROM "AgentJobEvent" WHERE "jobId" = ${jobId}`;
    await tx.$executeRaw`DELETE FROM "AgentCheckpoint" WHERE "runId" = ${row.runId} AND "userId" = ${userId}`;
    await tx.$executeRaw`DELETE FROM "AgentJob" WHERE "id" = ${jobId}`;
    return true;
  });
}

/**
 * 孤儿任务回收：running/queued 且心跳（或创建时间）早于 staleBefore 的任务。
 * 调用方需再结合"无 SSE 订阅者"判断后才物理删除。
 */
export async function findStaleActiveAgentJobs(staleBefore: Date): Promise<AgentJobRecord[]> {
  const jobs = await prisma.$queryRaw<AgentJobRecord[]>`
    SELECT * FROM "AgentJob"
    WHERE "status" IN ('queued', 'running')
      AND (
        ("heartbeatAt" IS NOT NULL AND "heartbeatAt" < ${staleBefore})
        OR ("heartbeatAt" IS NULL AND "createdAt" < ${staleBefore})
      )
    ORDER BY "createdAt" ASC
    LIMIT 50
  `;
  return jobs.map((job) => normalizeJob(job as AgentJobRecord));
}

export async function completeAgentJob(
  jobId: string,
  result: unknown,
  status: "succeeded" | "waiting_user" = "succeeded",
): Promise<number> {
  const resultJson = toJsonString(result);
  return prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = ${status},
        "result" = ${resultJson}::jsonb,
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = CASE WHEN ${status} = 'succeeded' THEN now() ELSE NULL END,
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "status" IN ('running', 'waiting_user')
  `;
}

export async function updateAgentJobRunId(
  jobId: string,
  runId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "runId" = ${runId},
        "updatedAt" = now()
    WHERE "id" = ${jobId}
  `;
}

export async function failAgentJob(
  job: AgentJobRecord,
  error: string,
): Promise<void> {
  const retry = job.attempt < job.maxAttempts;
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = ${retry ? "queued" : "failed"},
        "error" = ${error},
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = CASE WHEN ${retry} THEN NULL ELSE now() END,
        "updatedAt" = now()
    WHERE "id" = ${job.id}
  `;
}

export async function cancelAgentJob(
  jobId: string,
  userId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "userId" = ${userId}
      AND "status" IN ('queued', 'running', 'waiting_user')
  `;
}

export async function abandonAgentJob(
  jobId: string,
  userId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "error" = 'Abandoned after browser close or page refresh',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "userId" = ${userId}
      AND "status" IN ('queued', 'running', 'waiting_user')
  `;
}

export async function abandonAgentJobById(
  jobId: string,
  userId: string,
): Promise<void> {
  // 用户说了新任务（非"继续"）→ 可恢复队列里的旧任务标记 abandoned（终态，不可恢复）
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'abandoned',
        "error" = 'Abandoned: 用户开始了新任务',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "userId" = ${userId}
      AND "status" = 'canceled'
  `;
}

export async function cancelAgentJobById(jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "status" IN ('queued', 'running', 'waiting_user')
  `;
}

export async function cancelActiveAgentJobsByUser(
  userId: string,
): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'canceled',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
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
  level?: "info" | "warn" | "error";
  traceId?: string;
  parentEventId?: string;
  durationMs?: number;
}): Promise<AgentJobEventRecord> {
  const id = randomUUID();
  const payloadJson =
    input.payload === undefined ? null : toJsonString(input.payload);
  const rows = await prisma.$queryRaw<AgentJobEventRecord[]>`
    INSERT INTO "AgentJobEvent" ("id", "jobId", "type", "level", "stepId", "message", "payload", "traceId", "parentEventId", "durationMs")
    VALUES (${id}, ${input.jobId}, ${input.type}, ${input.level ?? "info"}, ${input.stepId ?? null}, ${input.message ?? null}, ${payloadJson}::jsonb, ${input.traceId ?? null}, ${input.parentEventId ?? null}, ${input.durationMs ?? null})
    RETURNING *
  `;
  const event = rows[0];
  return event as AgentJobEventRecord;
}

export async function listAgentJobEvents(
  jobId: string,
  after?: Date,
  limit = 200,
): Promise<AgentJobEventRecord[]> {
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

export async function heartbeatAgentJob(
  jobId: string,
  workerId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "heartbeatAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "lockedBy" = ${workerId}
      AND "status" = 'running'
  `;
}
//业务进度刷新
export async function touchAgentJobProgress(
  jobId: string,
  workerId: string,
): Promise<void> {
  //- `wHERE id + lockedBy + status='running'`：和心跳更新一样做持有者校验；**不是持有这个任务的 worker，不能刷新进度**，防止乱改。
  // - 作用：把`progressUpdatedAt`设置为当前时间，代表业务有向
  await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "progressUpdatedAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "lockedBy" = ${workerId}
      AND "status" = 'running'
  `;
}
//故障回收函数
export async function recoverStaleAgentJobs(input: {
  heartbeatStaleBefore: Date;
  progressStaleBefore: Date;
}): Promise<{
  hardTimedOut: number;
  progressStalled: number;
  heartbeatFailed: number;
  heartbeatRequeued: number;
  total: number;
}> {
  // 任务硬最大执行时间
  const hardTimedOut = await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'failed',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "error" = 'Job exceeded max execution time',
        "updatedAt" = now()
    WHERE "status" = 'running'
      AND "startedAt" IS NOT NULL
      AND "maxExecutionMs" IS NOT NULL
      AND "startedAt" < now() - ("maxExecutionMs" * interval '1 millisecond')
  `;
  //心跳超时，重试次数用尽，直接失效
  const heartbeatFailed = await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'failed',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "error" = 'Worker heartbeat timed out; retry limit reached',
        "updatedAt" = now()
    WHERE "status" = 'running'
      AND "attempt" >= "maxAttempts"
      AND ("heartbeatAt" IS NULL OR "heartbeatAt" < ${input.heartbeatStaleBefore})
  `;
  //心跳超时，还剩下重试次数，重新入队
  const heartbeatRequeued = await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'queued',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "error" = 'Worker heartbeat timed out; job was requeued',
        "updatedAt" = now()
    WHERE "status" = 'running'
      AND "attempt" < "maxAttempts"
      AND ("heartbeatAt" IS NULL OR "heartbeatAt" < ${input.heartbeatStaleBefore})
  `;
  // 业务进度检测
  const progressStalled = await prisma.$executeRaw`
    UPDATE "AgentJob"
    SET "status" = 'failed',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "heartbeatAt" = NULL,
        "progressUpdatedAt" = NULL,
        "finishedAt" = now(),
        "error" = 'Job business progress stalled',
        "updatedAt" = now()
    WHERE "status" = 'running'
      AND "type" IN ('schedule_plan')
      AND ("progressUpdatedAt" IS NULL OR "progressUpdatedAt" < ${input.progressStaleBefore})
  `;
  return {
    hardTimedOut,
    progressStalled,
    heartbeatFailed,
    heartbeatRequeued,
    total: hardTimedOut + progressStalled + heartbeatFailed + heartbeatRequeued,
  };
}

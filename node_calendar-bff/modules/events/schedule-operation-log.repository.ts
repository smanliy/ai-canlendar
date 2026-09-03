import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prisma } from '../db/prisma';

export type ScheduleOperationType = 'CREATE' | 'UPDATE' | 'DELETE';

export interface ScheduleOperationLogRecord {
  id: string;
  userId: string;
  taskId: string;
  jobId: string | null;
  operateType: ScheduleOperationType;
  targetScheduleId: string;
  beforeSnapshot: unknown | null;
  afterSnapshot: unknown | null;
  isCompensated: boolean;
  compensatedAt: Date | null;
  compensationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type DbClient = typeof prisma | Prisma.TransactionClient;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function toJsonString(value: unknown): string {
  return JSON.stringify(toJson(value));
}

function getDb(db?: DbClient) {
  return db ?? prisma;
}

export async function createScheduleOperationLog(input: {
  userId: string;
  taskId: string;
  jobId?: string;
  operateType: ScheduleOperationType;
  targetScheduleId: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
}, db?: DbClient): Promise<ScheduleOperationLogRecord> {
  const client = getDb(db);
  const id = randomUUID();
  const beforeSnapshotJson = input.beforeSnapshot === undefined ? null : toJsonString(input.beforeSnapshot);
  const afterSnapshotJson = input.afterSnapshot === undefined ? null : toJsonString(input.afterSnapshot);
  const rows = await client.$queryRaw<ScheduleOperationLogRecord[]>`
    INSERT INTO "ScheduleOperationLog" (
      "id",
      "userId",
      "taskId",
      "jobId",
      "operateType",
      "targetScheduleId",
      "beforeSnapshot",
      "afterSnapshot"
    )
    VALUES (
      ${id},
      ${input.userId},
      ${input.taskId},
      ${input.jobId ?? null},
      ${input.operateType},
      ${input.targetScheduleId},
      ${beforeSnapshotJson}::jsonb,
      ${afterSnapshotJson}::jsonb
    )
    RETURNING *
  `;
  return rows[0] as ScheduleOperationLogRecord;
}

export async function listScheduleOperationLogsByTask(userId: string, taskId: string, limit = 100, db?: DbClient): Promise<ScheduleOperationLogRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const client = getDb(db);
  return client.$queryRaw<ScheduleOperationLogRecord[]>`
    SELECT *
    FROM "ScheduleOperationLog"
    WHERE "userId" = ${userId}
      AND "taskId" = ${taskId}
    ORDER BY "createdAt" ASC
    LIMIT ${safeLimit}
  `;
}

export async function listOutstandingLogsByTask(userId: string, taskId: string, db?: DbClient): Promise<ScheduleOperationLogRecord[]> {
  const client = getDb(db);
  return client.$queryRaw<ScheduleOperationLogRecord[]>`
    SELECT *
    FROM "ScheduleOperationLog"
    WHERE "userId" = ${userId}
      AND "taskId" = ${taskId}
      AND "isCompensated" = false
    ORDER BY "createdAt" DESC
  `;
}

export async function markScheduleOperationCompensated(input: {
  id: string;
  reason?: string;
}, db?: DbClient): Promise<void> {
  const client = getDb(db);
  await client.$executeRaw`
    UPDATE "ScheduleOperationLog"
    SET "isCompensated" = true,
        "compensatedAt" = now(),
        "compensationReason" = ${input.reason ?? null},
        "updatedAt" = now()
    WHERE "id" = ${input.id}
  `;
}

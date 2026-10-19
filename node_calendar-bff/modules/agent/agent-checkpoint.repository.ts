import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';
import { AgentCheckpointError } from './agent.errors';

export type AgentCheckpointStatus = 'pending' | 'resolved' | 'expired' | 'canceled';
export type AgentCheckpointType =
  | 'required_fields'
  | 'schedule_decision'
  | 'conflict_decision'
  | 'final_confirm'
  | 'annotation_review'
  | 'manual_pause'
  | 'events_persisted';

export interface AgentCheckpointRecord {
  id: string;
  runId: string;
  userId: string;
  jobId: string | null;
  type: AgentCheckpointType;
  stepName: string;
  prompt: string;
  options: unknown | null;
  resumePayload: unknown | null;
  stateSnapshot: unknown;
  status: AgentCheckpointStatus;
  version: number;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export async function createCheckpoint(input: {
  runId: string;
  userId: string;
  jobId?: string;
  type: AgentCheckpointType;
  stepName: string;
  prompt: string;
  options?: unknown;
  resumePayload?: unknown;
  stateSnapshot: unknown;
  expiresAt?: Date;
}): Promise<AgentCheckpointRecord> {
  await prisma.agentCheckpoint.updateMany({
    where: {
      runId: input.runId,
      userId: input.userId,
      status: 'pending'
    },
    data: {
      status: 'canceled',
      resolvedAt: new Date()
    }
  });

  const latest = await prisma.agentCheckpoint.findFirst({
    where: {
      runId: input.runId,
      userId: input.userId
    },
    orderBy: { version: 'desc' },
    select: { version: true }
  });

  const checkpoint = await prisma.agentCheckpoint.create({
    data: {
      runId: input.runId,
      userId: input.userId,
      jobId: input.jobId,
      type: input.type,
      stepName: input.stepName,
      prompt: input.prompt,
      options: input.options === undefined ? undefined : toJson(input.options),
      resumePayload: input.resumePayload === undefined ? undefined : toJson(input.resumePayload),
      stateSnapshot: toJson(input.stateSnapshot),
      version: (latest?.version ?? 0) + 1,
      expiresAt: input.expiresAt
    }
  });
  return checkpoint as AgentCheckpointRecord;
}

export async function findCurrentCheckpoint(runId: string, userId: string): Promise<AgentCheckpointRecord | null> {
  const checkpoint = await prisma.agentCheckpoint.findFirst({
    where: {
      runId,
      userId,
      status: 'pending'
    },
    orderBy: { version: 'desc' }
  });
  return checkpoint as AgentCheckpointRecord | null;
}

export async function findCheckpointForRollback(input: {
  runId: string;
  userId: string;
  checkpointId?: string;
  version?: number;
}): Promise<AgentCheckpointRecord | null> {
  const where = {
    runId: input.runId,
    userId: input.userId,
    ...(input.checkpointId ? { id: input.checkpointId } : {}),
    ...(input.version !== undefined ? { version: input.version } : {})
  };
  const checkpoint = await prisma.agentCheckpoint.findFirst({
    where,
    orderBy: { version: 'desc' }
  });
  return checkpoint as AgentCheckpointRecord | null;
}

export async function resolveCheckpoint(input: {
  runId: string;
  userId: string;
  checkpointId?: string;
  version?: number;
}): Promise<AgentCheckpointRecord | null> {
  const checkpoint = input.checkpointId
    ? await prisma.agentCheckpoint.findFirst({
        where: {
          id: input.checkpointId,
          runId: input.runId,
          userId: input.userId
        }
      })
    : await prisma.agentCheckpoint.findFirst({
        where: {
          runId: input.runId,
          userId: input.userId,
          status: 'pending'
        },
        orderBy: { version: 'desc' }
      });

  if (!checkpoint) return null;
  if (checkpoint.status !== 'pending') {
    throw new AgentCheckpointError('该确认节点已失效，请刷新当前任务状态', 'CHECKPOINT_INVALID');
  }
  if (input.version !== undefined && checkpoint.version !== input.version) {
    throw new AgentCheckpointError('确认节点版本不一致，请刷新当前任务状态', 'CHECKPOINT_VERSION_MISMATCH');
  }
  if (checkpoint.expiresAt && checkpoint.expiresAt.getTime() < Date.now()) {
    await prisma.agentCheckpoint.update({
      where: { id: checkpoint.id },
      data: {
        status: 'expired',
        resolvedAt: new Date()
      }
    });
    throw new AgentCheckpointError('确认节点已过期，请重新规划', 'CHECKPOINT_EXPIRED');
  }

  const resolved = await prisma.agentCheckpoint.update({
    where: { id: checkpoint.id },
    data: {
      status: 'resolved',
      resolvedAt: new Date()
    }
  });
  return resolved as AgentCheckpointRecord;
}

export async function expirePendingCheckpoints(staleBefore: Date): Promise<Array<{ id: string; jobId: string | null }>> {
  const checkpoints = await prisma.agentCheckpoint.findMany({
    where: {
      status: 'pending',
      expiresAt: {
        lt: staleBefore
      }
    },
    select: {
      id: true,
      jobId: true
    }
  });

  if (checkpoints.length === 0) return [];

  await prisma.agentCheckpoint.updateMany({
    where: {
      id: {
        in: checkpoints.map((item) => item.id)
      }
    },
    data: {
      status: 'expired',
      resolvedAt: new Date()
    }
  });

  return checkpoints.map((item) => ({ id: item.id, jobId: item.jobId }));
}

export async function cancelPendingCheckpointsByUser(userId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "AgentCheckpoint"
    SET "status" = 'canceled',
        "resolvedAt" = now(),
        "updatedAt" = now()
    WHERE "userId" = ${userId}
      AND "status" = 'pending'
  `;
}

/**
 * 断点唯一化：每个用户同时只保留一个 manual_pause 断点。
 * 新断点产生（或用户开启新任务）时，把旧的 pending manual_pause 全部置为 canceled。
 */
export async function supersedeManualPauseCheckpoints(userId: string, keepCheckpointId?: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "AgentCheckpoint"
    SET "status" = 'canceled',
        "resolvedAt" = now(),
        "updatedAt" = now()
    WHERE "userId" = ${userId}
      AND "type" = 'manual_pause'
      AND "status" = 'pending'
      AND "id" <> ${keepCheckpointId ?? ''}
  `;
}

/**
 * 查询用户当前可恢复的 manual_pause 断点（最新一个）。
 */
export async function findPendingManualPauseCheckpoint(userId: string): Promise<AgentCheckpointRecord | null> {
  const checkpoint = await prisma.agentCheckpoint.findFirst({
    where: {
      userId,
      type: 'manual_pause',
      status: 'pending'
    },
    orderBy: { version: 'desc' }
  });
  return checkpoint as AgentCheckpointRecord | null;
}

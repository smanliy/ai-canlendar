import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';

export type AgentCheckpointStatus = 'pending' | 'resolved' | 'expired' | 'canceled';
export type AgentCheckpointType = 'required_fields' | 'schedule_decision' | 'conflict_decision' | 'final_confirm' | 'annotation_review';

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
    throw new Error('该确认节点已失效，请刷新当前任务状态');
  }
  if (input.version !== undefined && checkpoint.version !== input.version) {
    throw new Error('确认节点版本不一致，请刷新当前任务状态');
  }
  if (checkpoint.expiresAt && checkpoint.expiresAt.getTime() < Date.now()) {
    await prisma.agentCheckpoint.update({
      where: { id: checkpoint.id },
      data: {
        status: 'expired',
        resolvedAt: new Date()
      }
    });
    throw new Error('确认节点已过期，请重新规划');
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

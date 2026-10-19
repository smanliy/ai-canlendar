import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prisma } from '../db/prisma';

type DbClient = typeof prisma | Prisma.TransactionClient;

function getDb(db?: DbClient) {
  return db ?? prisma;
}

export function findEventsByRange(userId: string, start?: Date, end?: Date, db?: DbClient) {
  const client = getDb(db);
  const timeWhere: Prisma.CalendarEventWhereInput =
    start && end
      ? {
          endTime: { gt: start },
          startTime: { lt: end }
        }
      : {};

  return client.calendarEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      ...timeWhere
    },
    orderBy: {
      startTime: 'asc'
    }
  });
}

export function findEventById(userId: string, id: string, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.findFirst({
    where: {
      id,
      userId,
      deletedAt: null
    }
  });
}

export function createEvent(userId: string, data: Omit<Prisma.CalendarEventUncheckedCreateInput, 'userId'>, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.create({
    data: {
      ...data,
      userId
    }
  });
}

export function updateEvent(userId: string, id: string, data: Prisma.CalendarEventUncheckedUpdateInput, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.updateMany({
    where: {
      id,
      userId,
      deletedAt: null
    },
    data
  });
}

export function softDeleteEvent(userId: string, id: string, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.updateMany({
    where: {
      id,
      userId,
      deletedAt: null
    },
    data: {
      deletedAt: new Date()
    }
  });
}

export function bulkCreateEvents(userId: string, data: Array<Omit<Prisma.CalendarEventCreateManyInput, 'userId'>>, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.createManyAndReturn({
    data: data.map((item) => ({
      ...item,
      userId
    }))
  });
}

export function findLatestAgentRunId(userId: string, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.findFirst({
    where: {
      userId,
      source: 'agent',
      agentRunId: { not: null },
      deletedAt: null
    },
    orderBy: {
      createdAt: 'desc'
    },
    select: {
      agentRunId: true,
      createdAt: true
    }
  });
}

export function countAgentEventsByRunId(userId: string, agentRunId: string, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.count({
    where: {
      userId,
      agentRunId,
      source: 'agent',
      deletedAt: null
    }
  });
}

/** 按 agentRunId 查已有日程：落库幂等检查（恢复重跑时避免重复建日程） */
export function findEventsByAgentRunId(userId: string, agentRunId: string, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.findMany({
    where: {
      userId,
      agentRunId,
      deletedAt: null
    },
    orderBy: {
      startTime: 'asc'
    }
  });
}

export function softDeleteEventsByAgentRunId(userId: string, agentRunId: string, db?: DbClient) {
  const client = getDb(db);
  return client.calendarEvent.updateMany({
    where: {
      userId,
      agentRunId,
      source: 'agent',
      deletedAt: null
    },
    data: {
      deletedAt: new Date()
    }
  });
}

export function createAgentCompensation(input: {
  userId: string;
  runId: string;
  type: string;
  reason?: string;
  affectedCount: number;
  payload?: unknown;
}) {
  const id = randomUUID();
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  return prisma.$queryRaw`
    INSERT INTO "AgentCompensation" ("id", "userId", "runId", "type", "status", "reason", "affectedCount", "payload")
    VALUES (${id}, ${input.userId}, ${input.runId}, ${input.type}, 'succeeded', ${input.reason ?? null}, ${input.affectedCount}, ${payloadJson}::jsonb)
    RETURNING *
  `;
}

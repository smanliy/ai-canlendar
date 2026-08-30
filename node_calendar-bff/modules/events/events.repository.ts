import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prisma } from '../db/prisma';

export function findEventsByRange(userId: string, start?: Date, end?: Date) {
  const timeWhere: Prisma.CalendarEventWhereInput =
    start && end
      ? {
          endTime: { gt: start },
          startTime: { lt: end }
        }
      : {};

  return prisma.calendarEvent.findMany({
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

export function findEventById(userId: string, id: string) {
  return prisma.calendarEvent.findFirst({
    where: {
      id,
      userId,
      deletedAt: null
    }
  });
}

export function createEvent(userId: string, data: Omit<Prisma.CalendarEventUncheckedCreateInput, 'userId'>) {
  return prisma.calendarEvent.create({
    data: {
      ...data,
      userId
    }
  });
}

export function updateEvent(userId: string, id: string, data: Prisma.CalendarEventUncheckedUpdateInput) {
  return prisma.calendarEvent.updateMany({
    where: {
      id,
      userId,
      deletedAt: null
    },
    data
  });
}

export function softDeleteEvent(userId: string, id: string) {
  return prisma.calendarEvent.updateMany({
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

export function bulkCreateEvents(userId: string, data: Array<Omit<Prisma.CalendarEventCreateManyInput, 'userId'>>) {
  return prisma.calendarEvent.createManyAndReturn({
    data: data.map((item) => ({
      ...item,
      userId
    }))
  });
}

export function findLatestAgentRunId(userId: string) {
  return prisma.calendarEvent.findFirst({
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
      agentRunId: true
    }
  });
}

export function softDeleteEventsByAgentRunId(userId: string, agentRunId: string) {
  return prisma.calendarEvent.updateMany({
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

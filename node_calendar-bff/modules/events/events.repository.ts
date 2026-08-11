import type { Prisma } from '@prisma/client';

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

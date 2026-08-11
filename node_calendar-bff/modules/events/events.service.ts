import * as eventRepository from './events.repository';
import type { EventPayload, EventUpdatePayload } from './events.schema';

function parseOptionalRange(start?: unknown, end?: unknown): { start?: Date; end?: Date } {
  if (start === undefined && end === undefined) return {};
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new Error('查询时间范围不完整');
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('查询时间格式不正确');
  }

  if (startDate >= endDate) {
    throw new Error('查询开始时间必须早于结束时间');
  }

  return { start: startDate, end: endDate };
}

function toCreateInput(payload: EventPayload, source = 'manual', agentRunId?: string) {
  return {
    title: payload.title,
    startTime: new Date(payload.startTime),
    endTime: new Date(payload.endTime),
    location: payload.location,
    category: payload.category,
    priority: payload.priority,
    note: payload.note,
    status: payload.status,
    source,
    agentRunId
  };
}

function toUpdateInput(payload: EventUpdatePayload) {
  return {
    ...payload,
    startTime: payload.startTime ? new Date(payload.startTime) : undefined,
    endTime: payload.endTime ? new Date(payload.endTime) : undefined
  };
}

export async function listEvents(userId: string, query: { start?: unknown; end?: unknown }) {
  const { start, end } = parseOptionalRange(query.start, query.end);
  return eventRepository.findEventsByRange(userId, start, end);
}

export async function createEvent(userId: string, payload: EventPayload) {
  return eventRepository.createEvent(userId, toCreateInput(payload));
}

export async function updateEvent(userId: string, id: string, payload: EventUpdatePayload) {
  const existing = await eventRepository.findEventById(userId, id);
  if (!existing) {
    throw new Error('日程不存在或已被删除');
  }

  const nextStartTime = payload.startTime ? new Date(payload.startTime) : existing.startTime;
  const nextEndTime = payload.endTime ? new Date(payload.endTime) : existing.endTime;
  if (nextStartTime >= nextEndTime) {
    throw new Error('开始时间必须早于结束时间');
  }

  const result = await eventRepository.updateEvent(userId, id, toUpdateInput(payload));
  if (result.count === 0) {
    throw new Error('日程不存在或已被删除');
  }

  const updated = await eventRepository.findEventById(userId, id);
  if (!updated) {
    throw new Error('日程不存在或已被删除');
  }
  return updated;
}

export async function deleteEvent(userId: string, id: string) {
  const result = await eventRepository.softDeleteEvent(userId, id);
  if (result.count === 0) {
    throw new Error('日程不存在或已被删除');
  }
}

export async function bulkCreateEvents(userId: string, payload: { events: EventPayload[]; agentRunId?: string }) {
  return eventRepository.bulkCreateEvents(
    userId,
    payload.events.map((event) => toCreateInput(event, payload.agentRunId ? 'agent' : 'manual', payload.agentRunId))
  );
}

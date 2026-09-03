import { prisma } from '../db/prisma';
import * as eventRepository from './events.repository';
import * as operationLogRepository from './schedule-operation-log.repository';
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

function readScheduleSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const record = snapshot as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const title = typeof record.title === 'string' ? record.title : '';
  const startTime = record.startTime instanceof Date ? record.startTime : typeof record.startTime === 'string' ? new Date(record.startTime) : null;
  const endTime = record.endTime instanceof Date ? record.endTime : typeof record.endTime === 'string' ? new Date(record.endTime) : null;
  if (!id || !title || !startTime || !endTime || Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    return null;
  }
  return {
    id,
    title,
    startTime,
    endTime,
    location: typeof record.location === 'string' ? record.location : null,
    category: typeof record.category === 'string' ? record.category : '',
    priority: typeof record.priority === 'string' ? record.priority : '',
    note: typeof record.note === 'string' ? record.note : null,
    status: typeof record.status === 'string' ? record.status : '未开始',
    source: typeof record.source === 'string' ? record.source : 'agent',
    agentRunId: typeof record.agentRunId === 'string' ? record.agentRunId : null,
    deletedAt: record.deletedAt instanceof Date ? record.deletedAt : null
  };
}

function snapshotToCreateInput(snapshot: ReturnType<typeof readScheduleSnapshot>, userId: string) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    userId,
    title: snapshot.title,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    location: snapshot.location,
    category: snapshot.category,
    priority: snapshot.priority,
    note: snapshot.note,
    status: snapshot.status,
    source: snapshot.source,
    agentRunId: snapshot.agentRunId
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
  if (!payload.agentRunId) {
    return eventRepository.bulkCreateEvents(userId, payload.events.map((event) => toCreateInput(event)));
  }

  const agentRunId = payload.agentRunId;
  return prisma.$transaction(async (tx) => {
    const created = await eventRepository.bulkCreateEvents(
      userId,
      payload.events.map((event) => toCreateInput(event, 'agent', agentRunId)),
      tx
    );

    for (const event of created) {
      await operationLogRepository.createScheduleOperationLog(
        {
          userId,
          taskId: agentRunId,
          operateType: 'CREATE',
          targetScheduleId: event.id,
          beforeSnapshot: null,
          afterSnapshot: event
        },
        tx
      );
    }

    return created;
  });
}

export async function undoAgentRunEvents(userId: string, agentRunId: string, reason = 'user_undo') {
  if (!agentRunId.trim()) {
    throw new Error('agentRunId 不能为空');
  }
  const runId = agentRunId.trim();

  return prisma.$transaction(async (tx) => {
    const logs = await operationLogRepository.listOutstandingLogsByTask(userId, runId, tx);
    if (logs.length === 0) {
      const result = await eventRepository.softDeleteEventsByAgentRunId(userId, runId, tx);
      if (result.count === 0) {
        throw new Error('没有找到可撤销的 Agent 日程');
      }
      await eventRepository.createAgentCompensation({
        userId,
        runId,
        type: 'undo_agent_calendar_events',
        reason,
        affectedCount: result.count,
        payload: { agentRunId: runId, mode: 'legacy_soft_delete' }
      });
      return {
        runId,
        affectedCount: result.count
      };
    }

    let affectedCount = 0;
    for (const log of logs) {
      const snapshot = readScheduleSnapshot(log.beforeSnapshot ?? log.afterSnapshot);
      if (log.operateType === 'CREATE') {
        const result = await eventRepository.softDeleteEvent(userId, log.targetScheduleId, tx);
        if (result.count > 0) affectedCount += result.count;
      } else if (snapshot) {
        const restoreInput = snapshotToCreateInput(snapshot, userId);
        if (!restoreInput) continue;
        const existing = await eventRepository.findEventById(userId, snapshot.id, tx);
        if (existing) {
          await eventRepository.updateEvent(
            userId,
            snapshot.id,
            {
              title: restoreInput.title,
              startTime: restoreInput.startTime,
              endTime: restoreInput.endTime,
              location: restoreInput.location,
              category: restoreInput.category,
              priority: restoreInput.priority,
              note: restoreInput.note,
              status: restoreInput.status,
              source: restoreInput.source,
              agentRunId: restoreInput.agentRunId,
              deletedAt: null
            },
            tx
          );
        } else {
          await eventRepository.createEvent(userId, restoreInput, tx);
        }
        affectedCount += 1;
      }
      await operationLogRepository.markScheduleOperationCompensated({ id: log.id, reason }, tx);
    }

    if (affectedCount === 0) {
      throw new Error('没有找到可撤销的 Agent 日程');
    }

    await eventRepository.createAgentCompensation({
      userId,
      runId,
      type: 'undo_agent_calendar_events',
      reason,
      affectedCount,
      payload: { agentRunId: runId, mode: 'operation_log' }
    });
    return {
      runId,
      affectedCount
    };
  });
}

export async function undoLatestAgentRunEvents(userId: string) {
  const latest = await eventRepository.findLatestAgentRunId(userId);
  const agentRunId = latest?.agentRunId;
  if (!agentRunId) {
    throw new Error('没有找到最近可撤销的 Agent 日程');
  }
  return undoAgentRunEvents(userId, agentRunId, 'user_undo_latest');
}

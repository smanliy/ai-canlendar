export const eventCategories = ['工作', '学习', '生活', '面试'] as const;
export const eventPriorities = ['高', '中', '低'] as const;
export const eventStatuses = ['未开始', '进行中', '已完成', '已延期'] as const;

export type EventCategory = (typeof eventCategories)[number];
export type EventPriority = (typeof eventPriorities)[number];
export type EventStatus = (typeof eventStatuses)[number];

export interface EventPayload {
  title: string;
  startTime: string;
  endTime: string;
  location?: string | null;
  category: EventCategory;
  priority: EventPriority;
  note?: string | null;
  status: EventStatus;
}

export interface BulkCreateEventsPayload {
  events: EventPayload[];
  agentRunId?: string;
}

export type EventUpdatePayload = Partial<EventPayload>;

function isInList<T extends readonly string[]>(value: unknown, list: T): value is T[number] {
  return typeof value === 'string' && list.includes(value);
}

function parseDate(value: unknown, label: string): Date {
  if (typeof value !== 'string') {
    throw new Error(`${label}不能为空`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label}格式不正确`);
  }
  return date;
}

function normalizeNullableText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

export function validateEventPayload(payload: unknown): EventPayload {
  const body = payload as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    throw new Error('标题不能为空');
  }

  const startTime = parseDate(body.startTime, '开始时间');
  const endTime = parseDate(body.endTime, '结束时间');
  if (startTime >= endTime) {
    throw new Error('开始时间必须早于结束时间');
  }

  if (!isInList(body.category, eventCategories)) {
    throw new Error('分类不正确');
  }

  if (!isInList(body.priority, eventPriorities)) {
    throw new Error('优先级不正确');
  }

  if (!isInList(body.status, eventStatuses)) {
    throw new Error('完成状态不正确');
  }

  return {
    title,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    location: normalizeNullableText(body.location),
    category: body.category,
    priority: body.priority,
    note: normalizeNullableText(body.note),
    status: body.status
  };
}

export function validateEventUpdatePayload(payload: unknown): EventUpdatePayload {
  const body = payload as Record<string, unknown>;
  const result: EventUpdatePayload = {};

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new Error('标题不能为空');
    result.title = title;
  }

  if (body.startTime !== undefined) result.startTime = parseDate(body.startTime, '开始时间').toISOString();
  if (body.endTime !== undefined) result.endTime = parseDate(body.endTime, '结束时间').toISOString();

  const startTime = result.startTime ?? (typeof body.currentStartTime === 'string' ? body.currentStartTime : undefined);
  const endTime = result.endTime ?? (typeof body.currentEndTime === 'string' ? body.currentEndTime : undefined);
  if (result.startTime && result.endTime && new Date(result.startTime) >= new Date(result.endTime)) {
    throw new Error('开始时间必须早于结束时间');
  }

  if (startTime && endTime && new Date(startTime) >= new Date(endTime)) {
    throw new Error('开始时间必须早于结束时间');
  }

  if (body.location !== undefined) result.location = normalizeNullableText(body.location);
  if (body.note !== undefined) result.note = normalizeNullableText(body.note);

  if (body.category !== undefined) {
    if (!isInList(body.category, eventCategories)) throw new Error('分类不正确');
    result.category = body.category;
  }

  if (body.priority !== undefined) {
    if (!isInList(body.priority, eventPriorities)) throw new Error('优先级不正确');
    result.priority = body.priority;
  }

  if (body.status !== undefined) {
    if (!isInList(body.status, eventStatuses)) throw new Error('完成状态不正确');
    result.status = body.status;
  }

  if (Object.keys(result).length === 0) {
    throw new Error('没有可更新的字段');
  }

  return result;
}

export function validateBulkCreatePayload(payload: unknown): BulkCreateEventsPayload {
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new Error('批量日程不能为空');
  }

  if (body.events.length > 50) {
    throw new Error('单次最多批量创建 50 条日程');
  }

  return {
    events: body.events.map(validateEventPayload),
    agentRunId: typeof body.agentRunId === 'string' && body.agentRunId.trim() ? body.agentRunId.trim() : undefined
  };
}

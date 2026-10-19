export interface CreateAgentRunPayload {
  input: string;
  clarificationJson?: unknown;
  forceNew?: boolean;
}

export function validateCreateAgentRunPayload(payload: unknown): CreateAgentRunPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }

  const input = (payload as { input?: unknown }).input;
  const clarificationJson = (payload as { clarificationJson?: unknown }).clarificationJson;
  const forceNew = (payload as { forceNew?: unknown }).forceNew;
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Input is required');
  }

  if (input.trim().length > 2000) {
    throw new Error('Input is too long');
  }

  return {
    input: input.trim(),
    clarificationJson,
    forceNew: typeof forceNew === 'boolean' ? forceNew : undefined
  };
}

export interface AgentDecisionPayload {
  optionId: string;
  taskId: string;
  checkpointId?: string;
  version?: number;
}

export function validateAgentDecisionPayload(payload: unknown): AgentDecisionPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }
  const optionId = (payload as { optionId?: unknown }).optionId;
  const taskId = (payload as { taskId?: unknown }).taskId;
  const checkpointId = (payload as { checkpointId?: unknown }).checkpointId;
  const version = (payload as { version?: unknown }).version;
  if (typeof optionId !== 'string' || !optionId.trim()) {
    throw new Error('optionId is required');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('taskId is required');
  }
  return {
    optionId: optionId.trim(),
    taskId: taskId.trim(),
    checkpointId: typeof checkpointId === 'string' && checkpointId.trim() ? checkpointId.trim() : undefined,
    version: typeof version === 'number' && Number.isInteger(version) ? version : undefined
  };
}

export interface AgentAnnotationPayload {
  planCardId: string;
  regionId: string;
  selectedText: string;
  comment: string;
  path?: string;
  kind?: string;
}

export function validateAgentAnnotationPayload(payload: unknown): AgentAnnotationPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }
  const body = payload as Record<string, unknown>;
  const planCardId = body.planCardId;
  const regionId = body.regionId;
  const selectedText = body.selectedText;
  const comment = body.comment;
  const path = body.path;
  const kind = body.kind;

  if (typeof planCardId !== 'string' || !planCardId.trim()) {
    throw new Error('planCardId is required');
  }
  if (typeof regionId !== 'string' || !regionId.trim()) {
    throw new Error('regionId is required');
  }
  if (typeof selectedText !== 'string' || !selectedText.trim()) {
    throw new Error('selectedText is required');
  }
  if (typeof comment !== 'string' || !comment.trim()) {
    throw new Error('comment is required');
  }
  if (comment.trim().length > 800) {
    throw new Error('comment is too long');
  }

  return {
    planCardId: planCardId.trim(),
    regionId: regionId.trim(),
    selectedText: selectedText.trim(),
    comment: comment.trim(),
    path: typeof path === 'string' && path.trim() ? path.trim() : undefined,
    kind: typeof kind === 'string' && kind.trim() ? kind.trim() : undefined
  };
}

export interface AgentRollbackPayload {
  checkpointId?: string;
  version?: number;
}

export interface AgentEventSelectionPayload {
  eventId: string;
  operation: {
    kind: 'event_update' | 'event_delete';
    target?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    allowConflict?: boolean;
  };
}

export interface AgentEventConflictResolutionPayload {
  action: 'keep_conflict' | 'shift_existing' | 'cancel';
  /** action=shift_existing 时必填：冲突日程后移的分钟数（用户在决策卡里编辑） */
  shiftMinutes?: number;
  /** action=shift_existing 时必填：要后移的冲突日程 id 列表 */
  conflictEventIds?: string[];
  operation: {
    kind: 'event_create' | 'event_update';
    event?: Record<string, unknown>;
    target?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    allowConflict?: boolean;
  };
}

export function validateAgentEventConflictResolutionPayload(payload: unknown): AgentEventConflictResolutionPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }
  const action = (payload as { action?: unknown }).action;
  if (action !== 'keep_conflict' && action !== 'shift_existing' && action !== 'cancel') {
    throw new Error('action must be keep_conflict, shift_existing or cancel');
  }
  const operation = (payload as { operation?: unknown }).operation;
  if (!operation || typeof operation !== 'object') {
    if (action === 'cancel') {
      return { action, operation: { kind: 'event_create' } };
    }
    throw new Error('operation is required');
  }
  const kind = (operation as { kind?: unknown }).kind;
  if (kind !== 'event_create' && kind !== 'event_update') {
    throw new Error('operation.kind must be event_create or event_update');
  }
  const record = operation as Record<string, unknown>;
  const readOptionalRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

  const shiftMinutes = (payload as { shiftMinutes?: unknown }).shiftMinutes;
  const conflictEventIds = (payload as { conflictEventIds?: unknown }).conflictEventIds;
  if (action === 'shift_existing') {
    if (typeof shiftMinutes !== 'number' || !Number.isFinite(shiftMinutes) || shiftMinutes <= 0) {
      throw new Error('shiftMinutes must be a positive number');
    }
    if (!Array.isArray(conflictEventIds) || conflictEventIds.length === 0) {
      throw new Error('conflictEventIds is required for shift_existing');
    }
  }

  return {
    action,
    shiftMinutes: typeof shiftMinutes === 'number' && Number.isFinite(shiftMinutes) ? shiftMinutes : undefined,
    conflictEventIds: Array.isArray(conflictEventIds)
      ? conflictEventIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
      : undefined,
    operation: {
      kind,
      event: readOptionalRecord(record.event),
      target: readOptionalRecord(record.target),
      patch: readOptionalRecord(record.patch),
      allowConflict: record.allowConflict === true
    }
  };
}

export function validateAgentEventSelectionPayload(payload: unknown): AgentEventSelectionPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }
  const eventId = (payload as { eventId?: unknown }).eventId;
  const operation = (payload as { operation?: unknown }).operation;
  if (typeof eventId !== 'string' || !eventId.trim()) {
    throw new Error('eventId is required');
  }
  if (!operation || typeof operation !== 'object') {
    throw new Error('operation is required');
  }
  const kind = (operation as { kind?: unknown }).kind;
  if (kind !== 'event_update' && kind !== 'event_delete') {
    throw new Error('operation.kind must be event_update or event_delete');
  }
  const target = (operation as { target?: unknown }).target;
  const patch = (operation as { patch?: unknown }).patch;
  const allowConflict = (operation as { allowConflict?: unknown }).allowConflict;
  return {
    eventId: eventId.trim(),
    operation: {
      kind,
      target:
        target && typeof target === 'object' && !Array.isArray(target)
          ? (target as Record<string, unknown>)
          : undefined,
      patch:
        patch && typeof patch === 'object' && !Array.isArray(patch)
          ? (patch as Record<string, unknown>)
          : undefined,
      allowConflict: allowConflict === true
    }
  };
}

export function validateAgentRollbackPayload(payload: unknown): AgentRollbackPayload {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object') {
    throw new Error('Request body must be an object');
  }
  const checkpointId = (payload as { checkpointId?: unknown }).checkpointId;
  const version = (payload as { version?: unknown }).version;
  return {
    checkpointId: typeof checkpointId === 'string' && checkpointId.trim() ? checkpointId.trim() : undefined,
    version: typeof version === 'number' && Number.isInteger(version) ? version : undefined
  };
}

export interface AgentConversationMessagePayload {
  role: 'user' | 'assistant';
  kind: 'userInput' | 'directAnswer' | 'agentSummary' | 'command' | 'agentCorrection';
  content: string;
  runId?: string;
  payload?: unknown;
}

export function validateAgentConversationMessagePayload(payload: unknown): AgentConversationMessagePayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }

  const role = (payload as { role?: unknown }).role;
  const kind = (payload as { kind?: unknown }).kind;
  const content = (payload as { content?: unknown }).content;
  const runId = (payload as { runId?: unknown }).runId;
  const messagePayload = (payload as { payload?: unknown }).payload;

  if (role !== 'user' && role !== 'assistant') {
    throw new Error('role must be user or assistant');
  }
  if (!['userInput', 'directAnswer', 'agentSummary', 'command', 'agentCorrection'].includes(String(kind))) {
    throw new Error('kind is invalid');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }
  if (content.trim().length > 8000) {
    throw new Error('content is too long');
  }

  return {
    role,
    kind: kind as AgentConversationMessagePayload['kind'],
    content: content.trim(),
    runId: typeof runId === 'string' && runId.trim() ? runId.trim() : undefined,
    payload: messagePayload
  };
}

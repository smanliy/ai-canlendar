export interface CreateAgentRunPayload {
  input: string;
  clarificationJson?: unknown;
}

export function validateCreateAgentRunPayload(payload: unknown): CreateAgentRunPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }

  const input = (payload as { input?: unknown }).input;
  const clarificationJson = (payload as { clarificationJson?: unknown }).clarificationJson;
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Input is required');
  }

  if (input.trim().length > 2000) {
    throw new Error('Input is too long');
  }

  return {
    input: input.trim(),
    clarificationJson
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
  kind: 'userInput' | 'directAnswer' | 'agentSummary' | 'command';
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
  if (!['userInput', 'directAnswer', 'agentSummary', 'command'].includes(String(kind))) {
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

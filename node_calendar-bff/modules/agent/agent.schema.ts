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
}

export function validateAgentDecisionPayload(payload: unknown): AgentDecisionPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }
  const optionId = (payload as { optionId?: unknown }).optionId;
  const taskId = (payload as { taskId?: unknown }).taskId;
  if (typeof optionId !== 'string' || !optionId.trim()) {
    throw new Error('optionId is required');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('taskId is required');
  }
  return {
    optionId: optionId.trim(),
    taskId: taskId.trim()
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

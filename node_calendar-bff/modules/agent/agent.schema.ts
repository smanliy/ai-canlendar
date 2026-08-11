export interface CreateAgentRunPayload {
  input: string;
}

export function validateCreateAgentRunPayload(payload: unknown): CreateAgentRunPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body is required');
  }

  const input = (payload as { input?: unknown }).input;
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Input is required');
  }

  if (input.trim().length > 2000) {
    throw new Error('Input is too long');
  }

  return {
    input: input.trim()
  };
}

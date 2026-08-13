import type { AgentUserPreference, ParsedScheduleTask } from './agent.types';

export interface PythonAgentPayload {
  userId: string;
  rawInput: string;
  userPreference: AgentUserPreference;
  parsedTask: ParsedScheduleTask;
}

export interface PythonAgentAck {
  message: string;
  received?: unknown;
}

export async function sendTaskToPythonAgent(payload: PythonAgentPayload): Promise<PythonAgentAck> {
  const pythonAgentUrl = process.env.PYTHON_AGENT_URL || 'http://127.0.0.1:8001';
  const url = `${pythonAgentUrl}/agent/tasks`;
  console.log('[Node -> Python] Forwarding parsed task to Python agent:', {
    url,
    userId: payload.userId,
    rawInput: payload.rawInput,
    userPreference: payload.userPreference,
    taskName: payload.parsedTask.taskName,
    subtaskCount: payload.parsedTask.subtasks.length
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('[Node -> Python] Request failed before Python acknowledged:', {
      url,
      error: error instanceof Error ? error.message : error
    });
    throw error;
  }

  const rawText = await response.text();
  let data: PythonAgentAck | null = null;

  if (rawText) {
    try {
      data = JSON.parse(rawText) as PythonAgentAck;
    } catch {
      throw new Error(`Python agent returned non-JSON response: ${rawText}`);
    }
  }

  if (!response.ok) {
    throw new Error(`Python agent request failed: HTTP ${response.status} ${rawText}`);
  }

  if (!data?.message) {
    throw new Error('Python agent returned empty acknowledgement');
  }

  console.log('[Node <- Python] Python agent acknowledged task:', {
    status: response.status,
    message: data.message
  });

  return data;
}

import type { AgentUserPreference, ParsedScheduleTask } from './agent.types';
import type { AgentFieldExtraction } from './field-extractor';

export interface PythonAgentPayload {
  userId: string;
  rawInput: string;
  userPreference: AgentUserPreference;
  normalizedContext?: Record<string, unknown>;
  parsedTask: ParsedScheduleTask;
}

export interface PythonAtomicTask {
  title: string;
  durationRangeMinutes: [number, number];
  plannedMinutes: number;
  dependsOn: string[];
  evidence: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    tool?: string;
  }>;
  order: number;
}

export interface PythonPlanPayload {
  userId: string;
  rawInput: string;
  userPreference: AgentUserPreference;
  normalizedContext: Record<string, unknown>;
}

export interface PythonPlanResult {
  status: 'ready' | 'overloaded' | 'failed';
  atomicTasks: PythonAtomicTask[];
  totalEstimatedMinutes: number;
  feasibility: {
    status: 'ok' | 'overloaded';
    availableMinutes?: number;
    requiredMinutes: number;
    issues: string[];
  };
  toolResults?: unknown;
}

export interface PythonAgentAck {
  message: string;
  finalValidation?: unknown;
  received?: unknown;
}

export interface PythonValidationPayload {
  userId: string;
  rawInput: string;
  userPreference: AgentUserPreference;
  llmExtraction: AgentFieldExtraction;
  clarificationJson?: unknown;
}

export type PythonValidationResult =
  | {
      status: 'needsUserInput';
      message: string;
      reasons: string[];
      clarificationJson: Record<string, string>;
    }
  | {
      status: 'ready';
      message: string;
      reasons: string[];
      normalizedContext: Record<string, unknown>;
    };

function getPythonAgentUrl(): string {
  return process.env.PYTHON_AGENT_URL || 'http://127.0.0.1:8001';
}

async function postPythonJson<T>(path: string, payload: unknown): Promise<T> {
  const pythonAgentUrl = getPythonAgentUrl();
  const url = `${pythonAgentUrl}${path}`;
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
  let data: T | null = null;

  if (rawText) {
    try {
      data = JSON.parse(rawText) as T;
    } catch {
      throw new Error(`Python agent returned non-JSON response: ${rawText}`);
    }
  }

  if (!response.ok) {
    throw new Error(`Python agent request failed: HTTP ${response.status} ${rawText}`);
  }

  if (!data) {
    throw new Error('Python agent returned empty response');
  }

  return data;
}

export async function validateAgentFieldsWithPython(payload: PythonValidationPayload): Promise<PythonValidationResult> {
  console.log('[Node -> Python] Validating agent fields:', {
    userId: payload.userId,
    rawInput: payload.rawInput,
    llmExtraction: payload.llmExtraction,
    clarificationJson: payload.clarificationJson
  });

  const result = await postPythonJson<PythonValidationResult>('/agent/validate', payload);
  console.log('[Node <- Python] Field validation result:', result);
  return result;
}

export async function planAtomicTasksWithPython(payload: PythonPlanPayload): Promise<PythonPlanResult> {
  console.log('[Node -> Python] Planning atomic tasks with Python tools:', {
    userId: payload.userId,
    rawInput: payload.rawInput,
    normalizedContext: payload.normalizedContext
  });

  const result = await postPythonJson<PythonPlanResult>('/agent/plan', payload);
  console.log('[Node <- Python] Atomic task plan result:', {
    status: result.status,
    taskCount: result.atomicTasks?.length ?? 0,
    feasibility: result.feasibility
  });
  return result;
}

export async function sendTaskToPythonAgent(payload: PythonAgentPayload): Promise<PythonAgentAck> {
  console.log('[Node -> Python] Forwarding parsed task to Python agent:', {
    userId: payload.userId,
    rawInput: payload.rawInput,
    userPreference: payload.userPreference,
    normalizedContext: payload.normalizedContext,
    taskName: payload.parsedTask.taskName,
    subtaskCount: payload.parsedTask.subtasks.length
  });

  const data = await postPythonJson<PythonAgentAck>('/agent/tasks', payload);

  if (!data?.message) {
    throw new Error('Python agent returned empty acknowledgement');
  }

  console.log('[Node <- Python] Python agent acknowledged task:', {
    message: data.message
  });

  return data;
}

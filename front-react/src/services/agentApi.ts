import dayjs from 'dayjs';

import { useAuthStore } from '../stores/authStore';
import type {
  AgentConversationMessage,
  AgentCompressionSettings,
  AgentRunDetail,
  AgentRunStep,
  AgentRunStatus,
  AgentTokenMetricsSnapshot,
  AgentTrace,
  AgentUserPreference,
  CalendarEventsToolResult,
  ConflictCheckResult,
  FreeWindowsToolResult,
  SchedulePlan,
  SchedulePlanOption,
  ScheduleToolResult,
  SplitResult,
  TokenUsage
} from '../types/agent';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export type SchedulePlanResult =
  | {
      status: 'commandResult';
      runId: string;
      command: 'clear' | 'compact';
      message: string;
      summary?: string;
    }
  | {
      status: 'llmAnswer';
      runId: string;
      rawInput: string;
      answer: string;
      reason: string;
    }
  | {
      status: 'autoCreated';
      runId: string;
      rawInput: string;
      message: string;
      createdCount: number;
      plan: SchedulePlanOption;
      calendarEventsToolResult?: CalendarEventsToolResult;
      freeWindowsToolResult?: FreeWindowsToolResult;
      scheduleToolResult?: ScheduleToolResult;
      conflictCheckResult?: ConflictCheckResult;
      agentTrace?: AgentTrace;
      llmUsageByStep?: Record<string, TokenUsage>;
    }
  | {
      status: 'needsUserInput';
      runId: string;
      rawInput: string;
      message: string;
      reasons: string[];
      clarificationJson: Record<string, unknown>;
      llmUsageByStep?: Record<string, TokenUsage>;
    }
  | {
      status: 'waitingConfirm';
      runId: string;
      plans: SchedulePlanOption[];
      plan?: SchedulePlanOption;
      conflicts: { id: string; message: string }[];
      calendarEventsToolResult?: CalendarEventsToolResult;
      freeWindowsToolResult?: FreeWindowsToolResult;
      scheduleToolResult?: ScheduleToolResult;
      conflictCheckResult?: ConflictCheckResult;
      agentTrace?: AgentTrace;
      llmUsageByStep?: Record<string, TokenUsage>;
    };

export type AgentStreamEvent =
  | { type: 'stepStarted'; stepId: string; message?: string }
  | { type: 'stepUpdated'; stepId: string; output?: unknown }
  | { type: 'stepSucceeded'; stepId: string; output?: unknown }
  | { type: 'stepFailed'; stepId: string; output?: unknown }
  | { type: 'directAnswer'; answer: string; reason: string }
  | { type: 'commandResult'; command: 'clear' | 'compact'; message: string; summary?: string }
  | { type: 'final'; data: SchedulePlanResult }
  | { type: 'error'; message: string; code?: number };

export type ConversationMessagePayload = Omit<AgentConversationMessage, 'id' | 'createdAt'> & {
  payload?: unknown;
};

export interface PlanAnnotationPayload {
  planCardId: string;
  regionId: string;
  selectedText: string;
  comment: string;
  path?: string;
  kind?: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const CSRF_COOKIE_NAME = 'chrono_csrf_token';

const stepNames = ['解析用户输入', '判断是否拆分', '查询已有日程', '计算空闲时间', '生成排期方案', '检测冲突', '等待用户确认', '执行写入日历'];

const now = () => dayjs().toISOString();

function readCookie(name: string): string | null {
  const encodedName = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split('; ').find((cookie) => cookie.startsWith(encodedName));
  return item ? decodeURIComponent(item.slice(encodedName.length)) : null;
}

function buildHeaders(options: RequestInit, token: string): HeadersInit {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? 'GET';
  const csrfToken = readCookie(CSRF_COOKIE_NAME);

  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  headers.set('Authorization', `Bearer ${token}`);

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  return headers;
}

async function parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const rawText = await response.text();
  let result: ApiResponse<T> | null = null;

  if (rawText) {
    try {
      result = JSON.parse(rawText) as ApiResponse<T>;
    } catch {
      throw new Error(response.ok ? '后端返回格式不是 JSON' : `接口请求失败: HTTP ${response.status}`);
    }
  }

  if (!result) {
    throw new Error(response.ok ? '后端返回为空' : `接口请求失败: HTTP ${response.status}`);
  }

  return result;
}

async function request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const token = useAuthStore.getState().token;
  if (!token) {
    const refreshed = await useAuthStore.getState().refreshSession();
    if (!refreshed) throw new Error('未登录或登录已过期');
    return request<T>(path, options, true);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: buildHeaders(options, token)
    });
  } catch {
    throw new Error('无法连接 Node 后端服务，请确认 node_calendar-bff 已启动');
  }

  const result = await parseResponse<T>(response);

  if (response.status === 401 && !retried) {
    const refreshed = await useAuthStore.getState().refreshSession();
    if (refreshed) return request<T>(path, options, true);
  }

  if (!response.ok || result.code !== 0) {
    throw new Error(result.message || `接口请求失败: HTTP ${response.status}`);
  }

  return result.data;
}

export const createInitialSteps = (): AgentRunStep[] =>
  stepNames.map((name, index) => ({
    id: `step-${index + 1}`,
    name,
    status: 'pending',
    input: { index: index + 1 },
    output: null,
    createdAt: now(),
    updatedAt: now()
  }));

function readResultStatus(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string' ? (value as { status: string }).status : '';
}

async function replayNonStreamResult(result: SchedulePlanResult, onEvent: (event: AgentStreamEvent) => void | Promise<void>) {
  if (result.status === 'commandResult') {
    await onEvent({
      type: 'commandResult',
      command: result.command,
      message: result.message,
      summary: result.summary
    });
    await onEvent({ type: 'final', data: result });
    return;
  }

  if (result.status === 'llmAnswer') {
    await onEvent({
      type: 'directAnswer',
      answer: result.answer,
      reason: result.reason
    });
    await onEvent({ type: 'final', data: result });
    return;
  }

  if (result.status === 'autoCreated') {
    await onEvent({
      type: 'directAnswer',
      answer: result.message,
      reason: '任务无需拆分且已找到理想时间'
    });
    await onEvent({ type: 'final', data: result });
    return;
  }

  if (result.status === 'needsUserInput') {
    await onEvent({
      type: 'stepUpdated',
      stepId: 'step-1',
      output: {
        message: result.message,
        reasons: result.reasons,
        llmUsage: result.llmUsageByStep?.['step-1'] ?? null
      }
    });
    await onEvent({ type: 'final', data: result });
    return;
  }

  await onEvent({
    type: 'stepSucceeded',
    stepId: 'step-1',
    output: {
      message: '用户输入已解析',
      llmUsage: result.llmUsageByStep?.['step-1'] ?? null
    }
  });
  await onEvent({
    type: 'stepSucceeded',
    stepId: 'step-3',
    output: {
      message: '已查询用户本地日程',
      calendarEventsResult: result.calendarEventsToolResult,
      agentTrace: result.agentTrace
    }
  });
  await onEvent({
    type: 'stepSucceeded',
    stepId: 'step-4',
    output: {
      message: '已根据本地日程和用户偏好计算空闲时间',
      freeWindowsResult: result.freeWindowsToolResult,
      agentTrace: result.agentTrace
    }
  });
  await onEvent({
    type: readResultStatus(result.scheduleToolResult) === 'needsDecision' ? 'stepUpdated' : 'stepSucceeded',
    stepId: 'step-5',
    output: {
      message: readResultStatus(result.scheduleToolResult) === 'needsDecision' ? '排期工具需要用户决策后才能继续' : '已调用 Python 排期工具生成草稿方案',
      scheduleToolResult: result.scheduleToolResult,
      agentTrace: result.agentTrace,
      llmUsage: result.llmUsageByStep?.['step-2'] ?? null
    }
  });
  if (readResultStatus(result.scheduleToolResult) === 'needsDecision' || readResultStatus(result.scheduleToolResult) === 'pending') {
    await onEvent({ type: 'final', data: result });
    return;
  }
  await onEvent({
    type: readResultStatus(result.conflictCheckResult) === 'needsDecision' ? 'stepUpdated' : 'stepSucceeded',
    stepId: 'step-6',
    output: {
      message: readResultStatus(result.conflictCheckResult) === 'needsDecision' ? '检测到未确认冲突，需要处理后才能继续' : result.conflicts.length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突',
      conflictCheckResult: result.conflictCheckResult,
      agentTrace: result.agentTrace
    }
  });
  if (readResultStatus(result.conflictCheckResult) === 'needsDecision' || readResultStatus(result.conflictCheckResult) === 'pending') {
    await onEvent({ type: 'final', data: result });
    return;
  }
  await onEvent({
    type: 'stepSucceeded',
    stepId: 'step-7',
    output: {
      runId: result.runId,
      status: result.plans.length > 0 ? '等待用户选择方案' : '等待用户确认排期处理方式'
    }
  });
  await onEvent({ type: 'final', data: result });
}

export const agentApi = {
  async getCompressionSettings(): Promise<AgentCompressionSettings> {
    return request<AgentCompressionSettings>('/agent/compression');
  },

  async updateCompressionSettings(enabled: boolean): Promise<AgentCompressionSettings> {
    return request<AgentCompressionSettings>('/agent/compression', {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    });
  },

  async getTokenMetrics(): Promise<AgentTokenMetricsSnapshot> {
    return request<AgentTokenMetricsSnapshot>('/agent/token-metrics');
  },

  async listConversationMessages(): Promise<AgentConversationMessage[]> {
    return request<AgentConversationMessage[]>('/agent/messages');
  },

  async saveConversationMessage(message: ConversationMessagePayload): Promise<AgentConversationMessage> {
    return request<AgentConversationMessage>('/agent/messages', {
      method: 'POST',
      body: JSON.stringify(message)
    });
  },

  async clearConversationMessages(): Promise<{ cleared: true }> {
    return request<{ cleared: true }>('/agent/messages', {
      method: 'DELETE'
    });
  },

  async schedulePlanStream(
    input: string,
    clarificationJson: unknown,
    onEvent: (event: AgentStreamEvent) => void | Promise<void>
  ): Promise<SchedulePlanResult> {
    if (!input.trim()) throw new Error('请输入排期目标');

    const token = useAuthStore.getState().token;
    if (!token) {
      const refreshed = await useAuthStore.getState().refreshSession();
      if (!refreshed) throw new Error('未登录或登录已过期');
      return agentApi.schedulePlanStream(input, clarificationJson, onEvent);
    }

    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/agent/runs/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: buildHeaders(
          {
            method: 'POST',
            body: JSON.stringify({ input, clarificationJson })
          },
          token
        ),
        body: JSON.stringify({ input, clarificationJson })
      });
    } catch {
      throw new Error('无法连接 Node 后端服务，请确认 node_calendar-bff 已启动');
    }

    if (!response.ok || !response.body) {
      const rawText = await response.text().catch(() => '');
      if (response.status === 404 && rawText.includes('Cannot POST')) {
        const fallbackResult = await agentApi.schedulePlan(input, clarificationJson);
        await replayNonStreamResult(fallbackResult, onEvent);
        return fallbackResult;
      }
      throw new Error(rawText || `接口请求失败: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: SchedulePlanResult | null = null;

    const dispatchBlock = async (block: string) => {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith('event:'));
      const dataLines = lines.filter((line) => line.startsWith('data:'));
      const eventName = eventLine?.slice('event:'.length).trim() || 'message';
      const dataText = dataLines.map((line) => line.slice('data:'.length).trim()).join('\n');
      if (!dataText || eventName === 'run:start' || eventName === 'done') return;

      const payload = JSON.parse(dataText) as AgentStreamEvent;
      if (eventName === 'error') {
        const message = typeof (payload as { message?: unknown }).message === 'string' ? (payload as { message: string }).message : 'Agent stream failed';
        await onEvent({ type: 'error', message });
        throw new Error(message);
      }

      await onEvent(payload);
      if (payload.type === 'final') {
        finalResult = payload.data;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let separatorIndex = buffer.search(/\r?\n\r?\n/);
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(buffer[separatorIndex] === '\r' ? separatorIndex + 4 : separatorIndex + 2);
        if (block.trim()) await dispatchBlock(block);
        separatorIndex = buffer.search(/\r?\n\r?\n/);
      }

      if (done) break;
    }

    if (buffer.trim()) await dispatchBlock(buffer);
    if (!finalResult) throw new Error('Agent stream ended without final result');
    return finalResult;
  },

  async schedulePlan(input: string, clarificationJson?: unknown): Promise<SchedulePlanResult> {
    if (!input.trim()) throw new Error('请输入排期目标');

    const data = await request<{
      status: 'needsUserInput' | 'waitingConfirm' | 'commandResult' | 'llmAnswer' | 'autoCreated';
      runId: string;
      command?: 'clear' | 'compact';
      answer?: string;
      reason?: string;
      summary?: string;
      rawInput?: string;
      userPreference?: AgentUserPreference;
      message?: string;
      reasons?: string[];
      clarificationJson?: Record<string, unknown>;
      plans?: SchedulePlanOption[];
      plan?: SchedulePlanOption;
      conflicts?: { id: string; message: string }[];
      createdCount?: number;
      pythonAgentAck?: { message: string };
      calendarEventsToolResult?: CalendarEventsToolResult;
      freeWindowsToolResult?: FreeWindowsToolResult;
      scheduleToolResult?: ScheduleToolResult;
      conflictCheckResult?: ConflictCheckResult;
      agentTrace?: AgentTrace;
      llmUsageByStep?: Record<string, TokenUsage>;
    }>('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ input, clarificationJson })
    });

    if (data.status === 'commandResult') {
      return {
        status: 'commandResult',
        runId: data.runId,
        command: data.command ?? 'compact',
        message: data.message || '命令已执行',
        summary: data.summary
      };
    }

    if (data.status === 'llmAnswer') {
      return {
        status: 'llmAnswer',
        runId: data.runId,
        rawInput: data.rawInput ?? input,
        answer: data.answer ?? '',
        reason: data.reason ?? ''
      };
    }

    if (data.status === 'autoCreated') {
      return {
        status: 'autoCreated',
        runId: data.runId,
        rawInput: data.rawInput ?? input,
        message: data.message || '已找到理想时间并写入日历。',
        createdCount: data.createdCount ?? 0,
        plan: data.plan as SchedulePlanOption,
        calendarEventsToolResult: data.calendarEventsToolResult,
        freeWindowsToolResult: data.freeWindowsToolResult,
        scheduleToolResult: data.scheduleToolResult,
        conflictCheckResult: data.conflictCheckResult,
        agentTrace: data.agentTrace,
        llmUsageByStep: data.llmUsageByStep
      };
    }

    if (data.status === 'needsUserInput') {
      return {
        status: 'needsUserInput',
        runId: data.runId,
        rawInput: data.rawInput ?? input,
        message: data.message || '信息还不够明确，请补全 JSON 后再次发送。',
        reasons: data.reasons ?? [],
        clarificationJson: data.clarificationJson ?? {},
        llmUsageByStep: data.llmUsageByStep
      };
    }

    if (!data.plans || !data.conflicts) {
      throw new Error('后端没有返回排期方案');
    }

    return {
      status: 'waitingConfirm',
      runId: data.runId,
      plans: data.plans,
      plan: data.plan,
      conflicts: data.conflicts,
      calendarEventsToolResult: data.calendarEventsToolResult,
      freeWindowsToolResult: data.freeWindowsToolResult,
      scheduleToolResult: data.scheduleToolResult,
      conflictCheckResult: data.conflictCheckResult,
      agentTrace: data.agentTrace,
      llmUsageByStep: data.llmUsageByStep
    };
  },

  async confirm(runId: string): Promise<{ status: AgentRunStatus }> {
    if (!runId) throw new Error('缺少 RunId');
    return { status: 'success' };
  },

  async submitDecision(runId: string, decision: { optionId: string; taskId: string }): Promise<{
    status: 'waitingConfirm';
    runId: string;
    plans: SchedulePlanOption[];
    plan?: SchedulePlan;
    conflicts: { id: string; message: string }[];
    scheduleToolResult?: ScheduleToolResult;
    conflictCheckResult?: ConflictCheckResult;
    splitResult?: SplitResult;
    agentTrace?: AgentTrace;
  }> {
    if (!runId) throw new Error('缺少 RunId');
    return request(`/agent/runs/${encodeURIComponent(runId)}/decision`, {
      method: 'POST',
      body: JSON.stringify(decision)
    });
  },

  async submitAnnotation(runId: string, annotation: PlanAnnotationPayload): Promise<{
    status: 'waitingConfirm';
    runId: string;
    plans: SchedulePlanOption[];
    plan?: SchedulePlan;
    conflicts: { id: string; message: string }[];
    annotation: {
      planCardId: string;
      regionId: string;
      path: string;
      previousText: string;
      nextText: string;
    };
  }> {
    if (!runId) throw new Error('缺少 RunId');
    return request(`/agent/runs/${encodeURIComponent(runId)}/annotation`, {
      method: 'POST',
      body: JSON.stringify(annotation)
    });
  },

  async getRun(runId: string, step?: AgentRunStep, rawInput = ''): Promise<AgentRunDetail> {
    return {
      runId,
      status: step?.status === 'failed' ? 'failed' : 'running',
      rawInput,
      currentNodeName: step?.name ?? '解析用户输入',
      nodeInput: step?.input ?? { rawInput },
      nodeOutput: step?.output ?? { message: '等待节点输出' },
      error: step?.error,
      createdAt: step?.createdAt ?? now(),
      updatedAt: step?.updatedAt ?? now()
    };
  }
};

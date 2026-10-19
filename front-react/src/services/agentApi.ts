import dayjs from 'dayjs';

import { useAuthStore } from '../stores/authStore';
import type {
  AgentJob,
  AgentCheckpoint,
  AgentJobDetail,
  AgentJobEvent,
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

export interface EventSelectionOptionView {
  eventId: string;
  title: string;
  timeText: string;
}

export interface EventConflictOptionView {
  eventId: string;
  title: string;
  timeText: string;
}

export interface PendingEventConflictView {
  message: string;
  conflicts: EventConflictOptionView[];
  suggestedShiftMinutes: number;
  pendingOperation: {
    kind: 'event_create' | 'event_update';
    event?: Record<string, unknown>;
    target?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    allowConflict?: boolean;
  };
}

export type SchedulePlanResult =  | {
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
      status: 'needsSelection';
      runId: string;
      rawInput: string;
      message: string;
      options: EventSelectionOptionView[];
      pendingOperation: {
        kind: 'event_update' | 'event_delete';
        target?: Record<string, unknown>;
        patch?: Record<string, unknown>;
        allowConflict?: boolean;
      };
      reason?: string;
    }
  | {
      status: 'needsConflictResolution';
      runId: string;
      rawInput: string;
      message: string;
      conflicts: EventConflictOptionView[];
      suggestedShiftMinutes: number;
      pendingOperation: {
        kind: 'event_create' | 'event_update';
        event?: Record<string, unknown>;
        target?: Record<string, unknown>;
        patch?: Record<string, unknown>;
        allowConflict?: boolean;
      };
      reason?: string;
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

/** 当前标签页唯一标识：SSE 订阅者登记 + 多标签页防误杀 */
export const AGENT_TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 页面重开恢复用：BFF /agent/jobs/active 的返回结构 */
export interface ActiveAgentJob {
  job: {
    id: string;
    runId: string;
    type: string;
    status: string;
    input: unknown;
    createdAt: string;
  };
  checkpoint: AgentCheckpoint | null;
  events: AgentJobEvent[];
}

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

async function consumeSseResponse(
  response: Response,
  onBlock: (eventName: string, dataText: string) => Promise<void> | void
): Promise<void> {
  if (!response.body) {
    throw new Error('流式响应不可用');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchBlock = async (block: string) => {
    const lines = block.split(/\r?\n/);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLines = lines.filter((line) => line.startsWith('data:'));
    const eventName = eventLine?.slice('event:'.length).trim() || 'message';
    const dataText = dataLines.map((line) => line.slice('data:'.length).trim()).join('\n');
    if (!dataText || eventName === 'run:start' || eventName === 'done') return;
    await onBlock(eventName, dataText);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let separatorIndex = buffer.search(/\r?\n\r?\n/);
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer[separatorIndex] === '\r' ? buffer.slice(separatorIndex + 4) : buffer.slice(separatorIndex + 2);
      if (block.trim()) await dispatchBlock(block);
      separatorIndex = buffer.search(/\r?\n\r?\n/);
    }

    if (done) break;
  }

  if (buffer.trim()) await dispatchBlock(buffer);
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

  if (result.status === 'needsSelection') {
    const optionLines = result.options
      .map((option, index) => `${index + 1}.「${option.title}」${option.timeText}`)
      .join('；');
    await onEvent({
      type: 'directAnswer',
      answer: `${result.message}：${optionLines}`,
      reason: result.reason ?? '日程定位存在多条候选，等待用户选择'
    });
    await onEvent({ type: 'final', data: result });
    return;
  }

  if (result.status === 'needsConflictResolution') {
    const conflictLines = result.conflicts
      .map((conflict, index) => `${index + 1}.「${conflict.title}」${conflict.timeText}`)
      .join('；');
    await onEvent({
      type: 'directAnswer',
      answer: `${result.message}：${conflictLines}。可以保留冲突、把原有日程后移 ${result.suggestedShiftMinutes} 分钟，或取消。`,
      reason: result.reason ?? '检测到时间冲突，等待用户决策'
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

  async listJobs(): Promise<AgentJob[]> {
    return request<AgentJob[]>('/agent/jobs');
  },

  async getActiveJobs(): Promise<ActiveAgentJob[]> {
    return request<ActiveAgentJob[]>('/agent/jobs/active');
  },

  async getJob(jobId: string): Promise<AgentJobDetail> {
    if (!jobId) throw new Error('缺少 JobId');
    return request<AgentJobDetail>(`/agent/jobs/${encodeURIComponent(jobId)}`);
  },

  async listJobEvents(jobId: string): Promise<AgentJobEvent[]> {
    if (!jobId) throw new Error('缺少 JobId');
    return request<AgentJobEvent[]>(`/agent/jobs/${encodeURIComponent(jobId)}/events`);
  },

  async createJob(input: { input: string; clarificationJson?: unknown; forceNew?: boolean }): Promise<AgentJob> {
    if (!input.input.trim()) throw new Error('请输入任务内容');
    return request<AgentJob>('/agent/jobs', {
      method: 'POST',
      body: JSON.stringify({
        input: input.input,
        clarificationJson: input.clarificationJson,
        forceNew: input.forceNew ?? false
      })
    });
  },

  async cancelJob(jobId: string): Promise<{ canceled: true; checkpoint?: AgentCheckpoint | null }> {
    if (!jobId) throw new Error('缺少 JobId');
    return request(`/agent/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST'
    });
  },

  /**
   * 用户在选项框里点定某条日程后回传 BFF，带着 eventId 重跑该改/删操作。
   */
  async resolveEventSelection(payload: {
    eventId: string;
    operation: {
      kind: 'event_update' | 'event_delete';
      target?: Record<string, unknown>;
      patch?: Record<string, unknown>;
      allowConflict?: boolean;
    };
  }): Promise<{ runId: string; status: 'llmAnswer'; answer: string; reason: string }> {
    if (!payload.eventId) throw new Error('缺少日程选择');
    return request('/agent/event-selection', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * 用户在冲突决策卡上做出选择后回传 BFF：
   * keep_conflict 保留冲突照常执行；shift_existing 先把冲突日程后移 N 分钟再执行；cancel 取消。
   */
  async resolveEventConflict(payload: {
    action: 'keep_conflict' | 'shift_existing' | 'cancel';
    shiftMinutes?: number;
    conflictEventIds?: string[];
    operation: PendingEventConflictView['pendingOperation'];
  }): Promise<{ runId: string; status: 'llmAnswer'; answer: string; reason: string }> {
    if (!payload.operation && payload.action !== 'cancel') throw new Error('缺少待执行操作');
    return request('/agent/event-conflict', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async streamJobEvents(
    jobId: string,
    onEvent: (eventName: string, payload: unknown) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    if (!jobId) throw new Error('缺少 JobId');

    const token = useAuthStore.getState().token;
    if (!token) {
      const refreshed = await useAuthStore.getState().refreshSession();
      if (!refreshed) throw new Error('未登录或登录已过期');
      return agentApi.streamJobEvents(jobId, onEvent, signal);
    }

    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/agent/jobs/${encodeURIComponent(jobId)}/events/stream?tabId=${encodeURIComponent(AGENT_TAB_ID)}`, {
        method: 'GET',
        credentials: 'include',
        headers: buildHeaders({ method: 'GET' }, token),
        signal
      });
    } catch {
      if (signal?.aborted) {
        throw new DOMException('Agent job stream aborted', 'AbortError');
      }
      throw new Error('无法连接 Node 后端服务，请确认 node_calendar-bff 已启动');
    }

    if (!response.ok) {
      const rawText = await response.text().catch(() => '');
      throw new Error(rawText || `接口请求失败: HTTP ${response.status}`);
    }

    await consumeSseResponse(response, async (eventName, dataText) => {
      const payload = JSON.parse(dataText) as unknown;
      await onEvent(eventName, payload);
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

    let finalResult: SchedulePlanResult | null = null;

    await consumeSseResponse(response, async (eventName, dataText) => {
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
    });
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
  },

  /**
   * 异常退出信号（pagehide 时调用）。
   * sendBeacon 无法携带 Authorization 头 → token 放 body，由 BFF beacon 端点自行校验；
   * 默认 Content-Type 为 text/plain → BFF 用 express.text() 解析。
   * 注意：这是 fire-and-forget，失败静默（由服务端孤儿回收器兜底）。
   */
  sendJobAbortBeacon(jobId: string, reason = 'abnormal_exit'): void {
    if (!jobId) return;
    const token = useAuthStore.getState().token;
    if (!token) return;
    try {
      navigator.sendBeacon(
        `${API_BASE_URL}/agent/jobs/abort`,
        JSON.stringify({ jobId, token, tabId: AGENT_TAB_ID, reason })
      );
    } catch {
      // beacon 失败是预期内的（崩溃场景），服务端 reaper 会兜底
    }
  }
};

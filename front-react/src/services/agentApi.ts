import dayjs from 'dayjs';

import { useAuthStore } from '../stores/authStore';
import type { AgentRunDetail, AgentRunStep, AgentRunStatus, AgentUserPreference, CalendarEventsToolResult, FreeWindowsToolResult, SchedulePlan, SchedulePlanOption } from '../types/agent';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export type SchedulePlanResult =
  | {
      status: 'needsUserInput';
      runId: string;
      rawInput: string;
      message: string;
      reasons: string[];
      clarificationJson: Record<string, unknown>;
    }
  | {
      status: 'waitingConfirm';
      runId: string;
      plans: SchedulePlanOption[];
      plan: SchedulePlan;
      conflicts: { id: string; message: string }[];
      calendarEventsToolResult?: CalendarEventsToolResult;
      freeWindowsToolResult?: FreeWindowsToolResult;
    };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const CSRF_COOKIE_NAME = 'chrono_csrf_token';

const stepNames = ['解析用户输入', '拆解子任务', '查询已有日程', '计算空闲时间', '生成排期方案', '检测冲突', '等待用户确认', '执行写入日历'];

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

export const agentApi = {
  async schedulePlan(input: string, clarificationJson?: unknown): Promise<SchedulePlanResult> {
    if (!input.trim()) throw new Error('请输入排期目标');

    const data = await request<{
      status: 'needsUserInput' | 'waitingConfirm';
      runId: string;
      rawInput?: string;
      userPreference?: AgentUserPreference;
      message?: string;
      reasons?: string[];
      clarificationJson?: Record<string, unknown>;
      plans?: SchedulePlanOption[];
      plan?: SchedulePlan;
      conflicts?: { id: string; message: string }[];
      pythonAgentAck?: { message: string };
      calendarEventsToolResult?: CalendarEventsToolResult;
      freeWindowsToolResult?: FreeWindowsToolResult;
    }>('/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ input, clarificationJson })
    });

    if (data.status === 'needsUserInput') {
      return {
        status: 'needsUserInput',
        runId: data.runId,
        rawInput: data.rawInput ?? input,
        message: data.message || '信息还不够明确，请补全 JSON 后再次发送。',
        reasons: data.reasons ?? [],
        clarificationJson: data.clarificationJson ?? {}
      };
    }

    if (!data.plans || !data.plan || !data.conflicts) {
      throw new Error('后端没有返回排期方案');
    }

    return {
      status: 'waitingConfirm',
      runId: data.runId,
      plans: data.plans,
      plan: data.plan,
      conflicts: data.conflicts,
      calendarEventsToolResult: data.calendarEventsToolResult,
      freeWindowsToolResult: data.freeWindowsToolResult
    };
  },

  async confirm(runId: string): Promise<{ status: AgentRunStatus }> {
    if (!runId) throw new Error('缺少 RunId');
    return { status: 'success' };
  },

  async revise(runId: string): Promise<{ status: AgentRunStatus }> {
    if (!runId) throw new Error('缺少 RunId');
    return { status: 'running' };
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

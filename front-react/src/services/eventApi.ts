import { useAuthStore } from '../stores/authStore';
import type { CalendarEvent, EventPayload } from '../types/event';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const CSRF_COOKIE_NAME = 'chrono_csrf_token';

function getToken() {
  return useAuthStore.getState().token;
}

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
      throw new Error(response.ok ? '后端返回格式不是 JSON' : `接口请求失败：HTTP ${response.status}`);
    }
  }

  if (!result) {
    throw new Error(response.ok ? '后端返回为空' : `接口请求失败：HTTP ${response.status}`);
  }

  return result;
}

async function request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const token = getToken();
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
    throw new Error(result.message || `接口请求失败：HTTP ${response.status}`);
  }

  return result.data;
}

function buildQuery(params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const queryString = query.toString();
  return queryString ? `?${queryString}` : '';
}

export const eventApi = {
  async getEvents(start?: string, end?: string): Promise<CalendarEvent[]> {
    return request(`/events${buildQuery({ start, end })}`);
  },

  async createEvent(payload: EventPayload): Promise<CalendarEvent> {
    return request('/events', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async updateEvent(id: string, payload: Partial<EventPayload>): Promise<CalendarEvent> {
    return request(`/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  },

  async deleteEvent(id: string): Promise<void> {
    await request<boolean>(`/events/${id}`, {
      method: 'DELETE'
    });
  },

  async bulkCreateEvents(items: EventPayload[], agentRunId?: string): Promise<CalendarEvent[]> {
    return request('/events/bulk', {
      method: 'POST',
      body: JSON.stringify({ events: items, agentRunId })
    });
  }
};

import type { AuthResult, LoginPayload, RegisterPayload, SmsCodePayload, User } from '../types/auth';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const CSRF_COOKIE_NAME = 'chrono_csrf_token';

function readCookie(name: string): string | null {
  const encodedName = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split('; ').find((cookie) => cookie.startsWith(encodedName));
  return item ? decodeURIComponent(item.slice(encodedName.length)) : null;
}

function buildHeaders(options: RequestInit): HeadersInit {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? 'GET';
  const csrfToken = readCookie(CSRF_COOKIE_NAME);

  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  return headers;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: buildHeaders(options)
    });
  } catch {
    throw new Error('无法连接 Node 后端服务，请确认 node_calendar-bff 已启动');
  }

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

  if (!response.ok || result.code !== 0) {
    throw new Error(result.message || `接口请求失败：HTTP ${response.status}`);
  }

  return result.data;
}

export const authApi = {
  async sendSmsCode(payload: SmsCodePayload): Promise<{ expiresIn: number; cooldown: number }> {
    return request('/auth/send-code', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async login(payload: LoginPayload): Promise<AuthResult> {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async register(payload: RegisterPayload): Promise<AuthResult> {
    return request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async refresh(): Promise<AuthResult> {
    return request('/auth/refresh', {
      method: 'POST'
    });
  },

  async logout(): Promise<boolean> {
    return request('/auth/logout', {
      method: 'POST'
    });
  },

  async me(token?: string | null): Promise<User> {
    if (!token) throw new Error('未登录或登录已过期');

    return request('/auth/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
  }
};

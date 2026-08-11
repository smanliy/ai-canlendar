import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { authApi } from '../services/authApi';
import type { LoginPayload, RegisterPayload, SmsCodePayload, User } from '../types/auth';

interface AuthState {
  user: User | null;
  token: string | null;
  csrfToken: string | null;
  expiresAt: string | null;
  loading: boolean;
  authChecked: boolean;
  checkingAuth: boolean;
  login: (payload: LoginPayload) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  sendSmsCode: (payload: SmsCodePayload) => Promise<void>;
  refreshSession: () => Promise<boolean>;
  checkSession: () => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  immer((set, get) => ({
    user: null,
    token: null,
    csrfToken: null,
    expiresAt: null,
    loading: false,
    authChecked: false,
    checkingAuth: false,
    login: async (payload) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const result = await authApi.login(payload);
        set((state) => {
          state.user = result.user;
          state.token = result.token;
          state.csrfToken = result.csrfToken;
          state.expiresAt = result.expiresAt;
          state.authChecked = true;
        });
      } finally {
        set((state) => {
          state.loading = false;
        });
      }
    },
    register: async (payload) => {
      set((state) => {
        state.loading = true;
      });
      try {
        const result = await authApi.register(payload);
        set((state) => {
          state.user = result.user;
          state.token = result.token;
          state.csrfToken = result.csrfToken;
          state.expiresAt = result.expiresAt;
          state.authChecked = true;
        });
      } finally {
        set((state) => {
          state.loading = false;
        });
      }
    },
    sendSmsCode: async (payload) => {
      await authApi.sendSmsCode(payload);
    },
    refreshSession: async () => {
      try {
        const result = await authApi.refresh();
        set((state) => {
          state.user = result.user;
          state.token = result.token;
          state.csrfToken = result.csrfToken;
          state.expiresAt = result.expiresAt;
          state.authChecked = true;
        });
        return true;
      } catch {
        set((state) => {
          state.user = null;
          state.token = null;
          state.csrfToken = null;
          state.expiresAt = null;
          state.authChecked = true;
        });
        return false;
      }
    },
    checkSession: async () => {
      const token = get().token;

      set((state) => {
        state.checkingAuth = true;
      });

      try {
        if (!token) {
          return await get().refreshSession();
        }

        const user = await authApi.me(token);
        set((state) => {
          state.user = user;
          state.authChecked = true;
        });
        return true;
      } catch {
        return await get().refreshSession();
      } finally {
        set((state) => {
          state.checkingAuth = false;
        });
      }
    },
    logout: async () => {
      try {
        await authApi.logout();
      } finally {
        set((state) => {
          state.user = null;
          state.token = null;
          state.csrfToken = null;
          state.expiresAt = null;
          state.authChecked = true;
          state.checkingAuth = false;
        });
      }
    }
  }))
);

import { Spin } from 'antd';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation, useNavigate } from 'react-router-dom';

import type { AppPageKey } from '../layouts/Sidebar';
import { AgentWorkspacePage } from '../pages/AgentWorkspacePage';
import { CalendarWorkspacePage } from '../pages/CalendarWorkspacePage';
import { LoginPage } from '../pages/LoginPage';
import { SettingsPage } from '../pages/SettingsPage';
import { useAuthStore } from '../stores/authStore';
import { Providers } from './providers';

function AuthLoading() {
  return (
    <div className="route-auth-loading">
      <Spin size="large" />
      <div className="route-auth-loading-text">正在校验登录状态...</div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((state) => state.token);
  const authChecked = useAuthStore((state) => state.authChecked);
  const checkingAuth = useAuthStore((state) => state.checkingAuth);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    if (!authChecked && !checkingAuth) {
      void checkSession();
    }
  }, [authChecked, checkSession, checkingAuth]);

  if (!authChecked || checkingAuth) {
    return <AuthLoading />;
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const token = useAuthStore((state) => state.token);
  const authChecked = useAuthStore((state) => state.authChecked);
  const checkingAuth = useAuthStore((state) => state.checkingAuth);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    if (!authChecked && !checkingAuth) {
      void checkSession();
    }
  }, [authChecked, checkSession, checkingAuth]);

  if (!authChecked || checkingAuth) {
    return <AuthLoading />;
  }

  if (token) {
    return <Navigate to="/agent" replace />;
  }

  return children;
}

const pageRoutes: Record<AppPageKey, string> = {
  agentWorkspace: '/agent',
  calendar: '/calendar',
  settings: '/settings'
};

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const onNavigate = (page: AppPageKey) => navigate(pageRoutes[page]);

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/agent" replace />} />
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route
        path="/agent"
        element={
          <RequireAuth>
            <AgentWorkspacePage activePage="agentWorkspace" onNavigate={onNavigate} />
          </RequireAuth>
        }
      />
      <Route
        path="/calendar"
        element={
          <RequireAuth>
            <CalendarWorkspacePage activePage="calendar" onNavigate={onNavigate} />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsPage activePage="settings" onNavigate={onNavigate} />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to={location.pathname === '/login' ? '/login' : '/agent'} replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <Providers>
      <Router future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppRoutes />
      </Router>
    </Providers>
  );
}

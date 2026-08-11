import { Card } from 'antd';

import { LoginForm } from '../features/auth/LoginForm';

export function LoginPage() {
  return (
    <main className="login-page">
      <div className="login-backdrop" />
      <Card className="login-card" variant="outlined">
        <div className="login-brand">
          <h1>ChronoAgent</h1>
          <p>手机号安全登录 · AI Time Manager</p>
        </div>
        <LoginForm />
      </Card>
    </main>
  );
}

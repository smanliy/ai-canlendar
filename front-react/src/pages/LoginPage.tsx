import { Card } from 'antd';

import { LoginForm } from '../features/auth/LoginForm';

export function LoginPage() {
  return (
    <main className="login-page">
      <div className="login-backdrop" />
      <div className="login-film-strip" aria-hidden="true" />
      <div className="login-sticky-note" aria-hidden="true">
        <span>review</span>
        <strong>19:00</strong>
        <em>plan check</em>
      </div>
      <Card className="login-card" variant="outlined">
        <div className="login-brand">
          <h1>ChronoAgent</h1>
          <p>登录后继续整理你的排期草稿</p>
        </div>
        <LoginForm />
      </Card>
    </main>
  );
}

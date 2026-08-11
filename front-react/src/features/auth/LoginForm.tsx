import { MobileOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Form, Input, Segmented, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { useAuthStore } from '../../stores/authStore';
import type { LoginPayload, RegisterPayload, SmsCodePayload } from '../../types/auth';

type AuthMode = SmsCodePayload['scene'];

const phoneRules = [
  { required: true, message: '请输入手机号' },
  { pattern: /^1[3-9]\d{9}$/, message: '请输入有效的 11 位手机号' }
];

export function LoginForm() {
  const { message } = AntApp.useApp();
  const [mode, setMode] = useState<AuthMode>('login');
  const [countdown, setCountdown] = useState(0);
  const [form] = Form.useForm<RegisterPayload>();
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const sendSmsCode = useAuthStore((state) => state.sendSmsCode);
  const loading = useAuthStore((state) => state.loading);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => setCountdown((current) => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const handleSendCode = async () => {
    try {
      const phone = await form.validateFields(['phone']).then((values) => values.phone);
      await sendSmsCode({ phone, scene: mode });
      setCountdown(60);
      message.success('验证码已发送，请在 Node 后端终端查看 mock code');
    } catch (err) {
      if (err instanceof Error) {
        message.error(err.message);
      }
    }
  };

  const handleSubmit = async (values: RegisterPayload) => {
    try {
      if (mode === 'register') {
        await register(values);
        message.success('注册并登录成功');
        return;
      }
      const payload: LoginPayload = { phone: values.phone, code: values.code };
      await login(payload);
      message.success('登录成功');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '认证失败');
    }
  };

  const handleModeChange = (value: AuthMode) => {
    setMode(value);
    form.resetFields(['code', 'nickname']);
    setCountdown(0);
  };

  return (
    <div className="auth-form-shell">
      <Segmented
        block
        value={mode}
        onChange={(value) => handleModeChange(value as AuthMode)}
        options={[
          { label: '登录', value: 'login' },
          { label: '注册', value: 'register' }
        ]}
      />

      <Form form={form} layout="vertical" onFinish={handleSubmit} className="auth-form" initialValues={{ phone: '13800138000' }}>
        {mode === 'register' ? (
          <Form.Item name="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
            <Input prefix={<UserOutlined />} placeholder="例如：李璐" maxLength={20} />
          </Form.Item>
        ) : null}

        <Form.Item name="phone" label="手机号" rules={phoneRules}>
          <Input prefix={<MobileOutlined />} placeholder="请输入手机号" maxLength={11} />
        </Form.Item>

        <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}>
          <Space.Compact className="auth-code-row">
            <Input prefix={<SafetyCertificateOutlined />} placeholder="6 位验证码" maxLength={6} />
            <Button onClick={() => void handleSendCode()} disabled={countdown > 0}>
              {countdown > 0 ? `${countdown}s` : '获取验证码'}
            </Button>
          </Space.Compact>
        </Form.Item>

        <Button type="primary" htmlType="submit" loading={loading} block>
          {mode === 'register' ? '注册并进入 ChronoAgent' : '登录 ChronoAgent'}
        </Button>
      </Form>

      <Typography.Paragraph className="auth-security-note">
        Mock 验证码会打印到 Node 后端终端。生产环境应由 Node 服务签发 JWT，并优先使用 HttpOnly Cookie、验证码限流和风控校验。
      </Typography.Paragraph>
    </div>
  );
}

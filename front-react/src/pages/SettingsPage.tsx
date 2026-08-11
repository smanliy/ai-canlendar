import { Button, Form, Input, Select, Switch, message } from 'antd';

import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';
import { useAuthStore } from '../stores/authStore';

interface SettingsPageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function SettingsPage({ activePage, onNavigate }: SettingsPageProps) {
  const logout = useAuthStore((state) => state.logout);
  const user = useAuthStore((state) => state.user);

  const handleSave = async () => {
    message.success('设置已保存');
  };

  return (
    <AppLayout
      activePage={activePage}
      title="设置"
      subtitle="账号、安全与个人偏好"
      showCalendarControls={false}
      onNavigate={onNavigate}
      onToday={() => undefined}
      onPrev={() => undefined}
      onNext={() => undefined}
      onCreate={() => undefined}
    >
      <main className="settings-main">
        <section className="settings-panel">
          <div className="settings-section">
            <h3>账号信息</h3>
            <Form layout="vertical" initialValues={{ nickname: user?.nickname, phone: user?.phone }}>
              <Form.Item label="昵称" name="nickname">
                <Input />
              </Form.Item>
              <Form.Item label="手机号" name="phone">
                <Input disabled />
              </Form.Item>
            </Form>
          </div>

          <div className="settings-section">
            <h3>修改密码</h3>
            <Form layout="vertical">
              <Form.Item label="当前密码" name="oldPassword">
                <Input.Password placeholder="请输入当前密码" />
              </Form.Item>
              <Form.Item label="新密码" name="newPassword">
                <Input.Password placeholder="请输入新密码" />
              </Form.Item>
              <Button onClick={() => message.success('密码修改请求已提交')}>修改密码</Button>
            </Form>
          </div>

          <div className="settings-section">
            <h3>个人偏好</h3>
            <Form
              layout="vertical"
              initialValues={{
                preferredTime: 'evening',
                dailyLimit: '2',
                avoidWeekend: true,
                defaultCategory: '学习'
              }}
              onFinish={handleSave}
            >
              <Form.Item label="偏好安排时间" name="preferredTime">
                <Select
                  options={[
                    { label: '上午', value: 'morning' },
                    { label: '下午', value: 'afternoon' },
                    { label: '晚上', value: 'evening' }
                  ]}
                />
              </Form.Item>
              <Form.Item label="每天最多安排" name="dailyLimit">
                <Select
                  options={[
                    { label: '1 小时', value: '1' },
                    { label: '2 小时', value: '2' },
                    { label: '3 小时', value: '3' },
                    { label: '4 小时', value: '4' }
                  ]}
                />
              </Form.Item>
              <Form.Item label="默认分类" name="defaultCategory">
                <Select options={['工作', '学习', '生活', '面试'].map((value) => ({ label: value, value }))} />
              </Form.Item>
              <Form.Item label="尽量避开周末" name="avoidWeekend" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                保存偏好
              </Button>
            </Form>
          </div>

          <div className="settings-section danger-zone">
            <h3>登录状态</h3>
            <Button danger onClick={logout}>
              退出登录
            </Button>
          </div>
        </section>
      </main>
    </AppLayout>
  );
}

import { AreaChartOutlined, CalendarOutlined, DatabaseOutlined, LogoutOutlined, PushpinOutlined, ReadOutlined, SettingOutlined } from '@ant-design/icons';
import { Avatar, Button, Tooltip } from 'antd';

import { useAuthStore } from '../stores/authStore';

export type AppPageKey = 'agentWorkspace' | 'agentOps' | 'calendar' | 'tokenMetrics' | 'settings';

const menuItems: Array<{ key: AppPageKey; label: string; icon: JSX.Element }> = [
  { key: 'agentWorkspace', label: '排期台', icon: <PushpinOutlined /> },
  { key: 'agentOps', label: '队列台', icon: <DatabaseOutlined /> },
  { key: 'calendar', label: '日历本', icon: <CalendarOutlined /> },
  { key: 'tokenMetrics', label: 'Token 账', icon: <AreaChartOutlined /> },
  { key: 'settings', label: '偏好夹', icon: <SettingOutlined /> }
];

interface SidebarProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const today = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  })
    .format(new Date())
    .replace(/\//g, '.');

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-title">ChronoAgent</div>
        <div className="brand-subtitle">study planner</div>
      </div>
      <div className="sidebar-spine-label" aria-hidden="true">
        <ReadOutlined />
        <span>plan book</span>
      </div>
      <nav className="sidebar-menu">
        {menuItems.map((item) => (
          <button key={item.key} className={`menu-item ${item.key === activePage ? 'active' : ''}`} type="button" onClick={() => onNavigate(item.key)}>
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-planner-ticket" aria-hidden="true">
        <span className="sidebar-ticket-label">today slip</span>
        <strong>No. {today}</strong>
        <div className="sidebar-ticket-ruler">
          <span />
          <span />
          <span />
          <span />
        </div>
        <em>review / arrange / confirm</em>
      </div>
      <div className="sidebar-user">
        <Avatar>{user?.nickname.slice(0, 1) ?? 'U'}</Avatar>
        <div className="sidebar-user-meta">
          <strong>{user?.nickname ?? 'Guest'}</strong>
          <span>在线</span>
        </div>
        <Tooltip title="退出">
          <Button aria-label="退出" type="text" icon={<LogoutOutlined />} onClick={logout} />
        </Tooltip>
      </div>
    </aside>
  );
}

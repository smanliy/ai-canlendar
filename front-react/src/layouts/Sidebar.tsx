import { CalendarOutlined, LogoutOutlined, RobotOutlined, SettingOutlined } from '@ant-design/icons';
import { Avatar, Button, Tooltip } from 'antd';

import { useAuthStore } from '../stores/authStore';

export type AppPageKey = 'agentWorkspace' | 'calendar' | 'settings';

const menuItems: Array<{ key: AppPageKey; label: string; icon: JSX.Element }> = [
  { key: 'agentWorkspace', label: 'Agent 工作台', icon: <RobotOutlined /> },
  { key: 'calendar', label: '日历', icon: <CalendarOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> }
];

interface SidebarProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-title">ChronoAgent</div>
        <div className="brand-subtitle">AI Time Manager</div>
      </div>
      <nav className="sidebar-menu">
        {menuItems.map((item) => (
          <button key={item.key} className={`menu-item ${item.key === activePage ? 'active' : ''}`} type="button" onClick={() => onNavigate(item.key)}>
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
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

import { BellOutlined, LeftOutlined, PlusOutlined, RightOutlined, UndoOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntApp, Avatar, Button, DatePicker, Dropdown, Input, Segmented, Tooltip } from 'antd';
import dayjs from 'dayjs';

import { eventApi } from '../services/eventApi';
import { useAuthStore } from '../stores/authStore';
import type { CalendarView } from '../stores/calendarStore';
import { useCalendarStore } from '../stores/calendarStore';
import { formatHeaderDate } from '../utils/date';

interface TopbarProps {
  title: string;
  subtitle?: string;
  showCalendarControls: boolean;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCreate: () => void;
}

const viewOptions = [
  { label: '月', value: 'dayGridMonth' },
  { label: '周', value: 'timeGridWeek' },
  { label: '日', value: 'timeGridDay' }
];

export function Topbar({ title, subtitle, showCalendarControls, onToday, onPrev, onNext, onCreate }: TopbarProps) {
  const { message } = AntApp.useApp();
  const currentDate = useCalendarStore((state) => state.currentDate);
  const currentView = useCalendarStore((state) => state.currentView);
  const setCurrentDate = useCalendarStore((state) => state.setCurrentDate);
  const setCurrentView = useCalendarStore((state) => state.setCurrentView);
  const user = useAuthStore((state) => state.user);
  const handleUndoLatestAgentRun = async () => {
    try {
      const result = await eventApi.undoLatestAgentRunEvents();
      window.dispatchEvent(new Event('chrono-calendar-events-changed'));
      message.success(`已撤销 ${result.affectedCount} 条 Agent 日程`);
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '没有可撤销的 Agent 日程');
    }
  };

  return (
    <header className="topbar">
      <div className="page-title">
        <h2>{title}</h2>
        <span>{subtitle ?? (showCalendarControls ? formatHeaderDate(currentDate) : '智能时间管理工作台')}</span>
      </div>
      {showCalendarControls ? (
        <div className="calendar-actions">
          <Button onClick={onToday}>今日</Button>
          <Tooltip title="上一页">
            <Button icon={<LeftOutlined />} onClick={onPrev} />
          </Tooltip>
          <Tooltip title="下一页">
            <Button icon={<RightOutlined />} onClick={onNext} />
          </Tooltip>
          <DatePicker value={dayjs(currentDate)} onChange={(date) => date && setCurrentDate(date.format('YYYY-MM-DD'))} />
          <Segmented value={currentView} options={viewOptions} onChange={(value) => setCurrentView(value as CalendarView)} />
        </div>
      ) : (
        <div className="calendar-actions" />
      )}
      <div className="topbar-right">
        {showCalendarControls ? <Input.Search placeholder="搜索日程" allowClear className="topbar-search" /> : null}
        {showCalendarControls ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            新建日程
          </Button>
        ) : null}
        <Tooltip title="通知">
          <Button icon={<BellOutlined />} />
        </Tooltip>
        <Dropdown
          trigger={['hover']}
          menu={{
            items: [
              {
                key: 'profile',
                icon: <UserOutlined />,
                label: user?.nickname ?? '当前用户',
                disabled: true
              },
              {
                type: 'divider'
              },
              {
                key: 'undo-agent-run',
                icon: <UndoOutlined />,
                label: '撤销最近 Agent 日程',
                onClick: handleUndoLatestAgentRun
              }
            ]
          }}
          placement="bottomRight"
        >
          <button className="topbar-user-trigger" type="button" aria-label="用户菜单">
            <Avatar>{user?.nickname.slice(0, 1) ?? 'U'}</Avatar>
          </button>
        </Dropdown>
      </div>
    </header>
  );
}

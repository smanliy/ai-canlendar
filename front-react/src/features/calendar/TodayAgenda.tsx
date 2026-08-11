import { Checkbox, List, Typography } from 'antd';
import { useMemo } from 'react';

import { EmptyState } from '../../components/EmptyState';
import { CategoryTag } from '../../components/StatusTag';
import { PriorityTag } from '../../components/PriorityTag';
import { useCalendarStore } from '../../stores/calendarStore';
import type { CalendarEvent } from '../../types/event';
import { formatTimeRange, isSameDay } from '../../utils/date';

interface TodayAgendaProps {
  events: CalendarEvent[];
  onToggleDone: (event: CalendarEvent, checked: boolean) => Promise<void>;
}

export function TodayAgenda({ events, onToggleDone }: TodayAgendaProps) {
  const currentDate = useCalendarStore((state) => state.currentDate);
  const todayEvents = useMemo(
    () => events.filter((event) => isSameDay(event.startTime, currentDate)).sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [currentDate, events]
  );
  const doneCount = todayEvents.filter((event) => event.status === '已完成').length;

  return (
    <section className="panel-block agenda-block">
      <div className="panel-title-row">
        <h3>今日清单</h3>
        <span>{doneCount}/{todayEvents.length}</span>
      </div>
      {todayEvents.length === 0 ? (
        <EmptyState description="今天暂无日程" />
      ) : (
        <List
          className="agenda-list"
          dataSource={todayEvents}
          renderItem={(event) => (
            <List.Item>
              <div className="agenda-item">
                <Checkbox checked={event.status === '已完成'} onChange={(e) => void onToggleDone(event, e.target.checked)} />
                <div className="agenda-content">
                  <Typography.Text type="secondary">{formatTimeRange(event.startTime, event.endTime)}</Typography.Text>
                  <strong>{event.title}</strong>
                  <div className="agenda-tags">
                    <CategoryTag category={event.category} />
                    <PriorityTag priority={event.priority} />
                  </div>
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
    </section>
  );
}

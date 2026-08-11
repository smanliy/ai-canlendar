import { Button, Typography } from 'antd';
import { useMemo } from 'react';

import { TodayVineTimeline, type VineEvent } from '../../constructor/TodayVineTimeline';
import { useAgentStore } from '../../stores/agentStore';
import { useCalendarStore } from '../../stores/calendarStore';
import type { CalendarEvent } from '../../types/event';
import { isSameDay } from '../../utils/date';
import { TodayAgenda } from '../calendar/TodayAgenda';

interface AgentContextPanelProps {
  events: CalendarEvent[];
  onToggleDone: (event: CalendarEvent, checked: boolean) => Promise<void>;
  onOpenCalendar: () => void;
}

function toTimestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function collectConflictIds(events: CalendarEvent[]) {
  const conflictIds = new Set<string>();

  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    const currentEnd = toTimestamp(current.endTime);

    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const next = events[nextIndex];
      const nextStart = toTimestamp(next.startTime);

      if (currentEnd > nextStart) {
        conflictIds.add(current.id);
        conflictIds.add(next.id);
      }
    }
  }

  return conflictIds;
}

function mapToVineEvents(events: CalendarEvent[], currentDate: string): VineEvent[] {
  const todayEvents = events
    .filter((event) => isSameDay(event.startTime, currentDate))
    .sort((a, b) => toTimestamp(a.startTime) - toTimestamp(b.startTime));
  const conflictIds = collectConflictIds(todayEvents);

  return todayEvents.map((event) => ({
    id: event.id,
    title: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    status: event.status === 'done?' ? 'done' : conflictIds.has(event.id) ? 'conflict' : 'normal',
    category: event.category,
    priority: event.priority
  }));
}

export function AgentContextPanel({ events, onToggleDone, onOpenCalendar }: AgentContextPanelProps) {
  const conflicts = useAgentStore((state) => state.conflicts);
  const currentDate = useCalendarStore((state) => state.currentDate);

  const vineEvents = useMemo(() => mapToVineEvents(events, currentDate), [currentDate, events]);

  return (
    <aside className="agent-context-panel">
      <TodayAgenda events={events} onToggleDone={onToggleDone} />

      <TodayVineTimeline events={vineEvents} />

      {conflicts.length > 0 ? (
        <Typography.Text type="secondary">Agent 发现 {conflicts.length} 条排期冲突建议</Typography.Text>
      ) : null}

      <Button className="context-calendar-button" onClick={onOpenCalendar}>
        查看完整日历
      </Button>

      {/* <section className="panel-block context-block">
        <div className="panel-title-row">
          <h3>偏好摘要</h3>
        </div>
        <div className="preference-list">
          <span>偏好时间：可在设置页调整</span>
          <span>每日容量：按偏好和空闲时间计算</span>
          <span>默认分类：跟随任务解析结果</span>
          <span>周末安排：跟随用户偏好</span>
        </div>
      </section> */}
    </aside>
  );
}

import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin, { DateClickArg, EventResizeDoneArg } from '@fullcalendar/interaction';
import timeGridPlugin from '@fullcalendar/timegrid';
import type { EventApi, EventContentArg } from '@fullcalendar/core';
import { App as AntApp } from 'antd';
import dayjs from 'dayjs';
import { RefObject } from 'react';

import { CalendarToolbar } from './CalendarToolbar';
import { categoryColors } from '../../components/StatusTag';
import { useCalendarStore } from '../../stores/calendarStore';
import type { CalendarEvent, EventPayload } from '../../types/event';
import { formatTimeRange } from '../../utils/date';

interface CalendarMainProps {
  calendarRef: RefObject<FullCalendar>;
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;
  onUpdate: (id: string, payload: Partial<EventPayload>) => Promise<unknown>;
}

interface EventMoveArg {
  event: EventApi;
  oldEvent: EventApi;
  revert: () => void;
}

const priorityDotColors = {
  高: '#DC2626',
  中: '#F59E0B',
  低: '#9CA3AF'
};

export function CalendarMain({ calendarRef, events, loading, error, onUpdate }: CalendarMainProps) {
  const { message } = AntApp.useApp();
  const currentView = useCalendarStore((state) => state.currentView);
  const currentDate = useCalendarStore((state) => state.currentDate);
  const openCreateModal = useCalendarStore((state) => state.openCreateModal);
  const openEditModal = useCalendarStore((state) => state.openEditModal);
  const setCurrentDate = useCalendarStore((state) => state.setCurrentDate);

  const fullCalendarEvents = events.map((event) => ({
    id: event.id,
    title: event.title,
    start: event.startTime,
    end: event.endTime,
    backgroundColor: categoryColors[event.category],
    borderColor: categoryColors[event.category],
    extendedProps: event
  }));

  const renderEventContent = (info: EventContentArg) => {
    const event = info.event.extendedProps as CalendarEvent;
    return (
      <div className="fc-event-inner">
        <span className="priority-dot" style={{ backgroundColor: priorityDotColors[event.priority] }} />
        <span className="fc-event-time-text">{formatTimeRange(event.startTime, event.endTime)}</span>
        <strong>{event.title}</strong>
      </div>
    );
  };

  const handleDateClick = (arg: DateClickArg) => {
    const startTime = dayjs(arg.date).toISOString();
    const endTime = dayjs(arg.date).add(1, 'hour').toISOString();
    openCreateModal({ startTime, endTime });
  };

  const persistMove = async (arg: EventMoveArg | EventResizeDoneArg) => {
    const original = arg.oldEvent.extendedProps as CalendarEvent;
    try {
      await onUpdate(arg.event.id, {
        startTime: arg.event.start?.toISOString() ?? original.startTime,
        endTime: arg.event.end?.toISOString() ?? original.endTime
      });
      message.success('日程时间已更新');
    } catch (err) {
      arg.revert();
      message.error(err instanceof Error ? err.message : '更新失败，已回滚');
    }
  };

  return (
    <section className="calendar-main">
      <CalendarToolbar loading={loading} error={error} />
      <FullCalendar
        ref={calendarRef}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        initialView={currentView}
        initialDate={currentDate}
        headerToolbar={false}
        height="100%"
        locale="zh-cn"
        editable
        selectable
        nowIndicator
        eventResizableFromStart
        allDaySlot={false}
        slotMinTime="07:00:00"
        slotMaxTime="23:00:00"
        events={fullCalendarEvents}
        eventContent={renderEventContent}
        dateClick={handleDateClick}
        eventClick={(arg) => openEditModal(arg.event.extendedProps as CalendarEvent)}
        eventDrop={persistMove}
        eventResize={persistMove}
        datesSet={(arg) => setCurrentDate(dayjs(arg.view.calendar.getDate()).format('YYYY-MM-DD'))}
      />
    </section>
  );
}

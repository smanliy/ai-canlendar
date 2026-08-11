import FullCalendar from '@fullcalendar/react';
import { useEffect, useRef, useState } from 'react';

import { AgentChatPanel } from '../features/agent/AgentChatPanel';
import { AgentRunDrawer } from '../features/agent/AgentRunDrawer';
import { CalendarMain } from '../features/calendar/CalendarMain';
import { EventModal } from '../features/calendar/EventModal';
import { TodayAgenda } from '../features/calendar/TodayAgenda';
import { useAgentRun } from '../hooks/useAgentRun';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';
import { useCalendarStore } from '../stores/calendarStore';
import type { AgentRunStep } from '../types/agent';
import type { CalendarEvent } from '../types/event';

interface CalendarWorkspacePageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function CalendarWorkspacePage({ activePage, onNavigate }: CalendarWorkspacePageProps) {
  const calendarRef = useRef<FullCalendar>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeStep] = useState<AgentRunStep | null>(null);
  const currentDate = useCalendarStore((state) => state.currentDate);
  const currentView = useCalendarStore((state) => state.currentView);
  const setCurrentDate = useCalendarStore((state) => state.setCurrentDate);
  const openCreateModal = useCalendarStore((state) => state.openCreateModal);

  const { events, loading, error, fetchEvents, createEvent, updateEvent, deleteEvent } = useCalendarEvents();
  const { generatePlan, confirmPlan, revisePlan, resetRun } = useAgentRun(fetchEvents);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.changeView(currentView);
  }, [currentView]);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.gotoDate(currentDate);
  }, [currentDate]);

  const handleToday = () => {
    const api = calendarRef.current?.getApi();
    api?.today();
    setCurrentDate(api?.getDate().toISOString() ?? new Date().toISOString());
  };

  const handlePrev = () => {
    const api = calendarRef.current?.getApi();
    api?.prev();
    setCurrentDate(api?.getDate().toISOString() ?? currentDate);
  };

  const handleNext = () => {
    const api = calendarRef.current?.getApi();
    api?.next();
    setCurrentDate(api?.getDate().toISOString() ?? currentDate);
  };

  const handleToggleDone = async (event: CalendarEvent, checked: boolean) => {
    await updateEvent(event.id, { status: checked ? '已完成' : '未开始' });
  };

  return (
    <AppLayout
      activePage={activePage}
      title="日历"
      showCalendarControls
      onNavigate={onNavigate}
      onToday={handleToday}
      onPrev={handlePrev}
      onNext={handleNext}
      onCreate={() => openCreateModal()}
    >
      <main className="workspace-main">
        <div className="calendar-column">
          <CalendarMain calendarRef={calendarRef} events={events} loading={loading} error={error} onUpdate={updateEvent} />
        </div>
        <aside className="right-panel">
          <TodayAgenda events={events} onToggleDone={handleToggleDone} />
          <AgentChatPanel onGenerate={generatePlan} onConfirm={confirmPlan} onRevise={revisePlan} onReject={resetRun} />
        </aside>
      </main>
      <EventModal events={events} onCreate={createEvent} onUpdate={updateEvent} onDelete={deleteEvent} />
      <AgentRunDrawer open={drawerOpen} step={activeStep} onClose={() => setDrawerOpen(false)} />
    </AppLayout>
  );
}

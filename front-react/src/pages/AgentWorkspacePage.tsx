import { AgentChatPanel } from '../features/agent/AgentChatPanel';
import { AgentContextPanel } from '../features/agent/AgentContextPanel';
import { EventModal } from '../features/calendar/EventModal';
import { useAgentRun } from '../hooks/useAgentRun';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';
import type { CalendarEvent } from '../types/event';

interface AgentWorkspacePageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function AgentWorkspacePage({ activePage, onNavigate }: AgentWorkspacePageProps) {
  const { events, fetchEvents, createEvent, updateEvent, deleteEvent } = useCalendarEvents();
  const { generatePlan, confirmPlan, revisePlan, resetRun } = useAgentRun(fetchEvents);

  const handleToggleDone = async (event: CalendarEvent, checked: boolean) => {
    await updateEvent(event.id, { status: checked ? '已完成' : '未开始' });
  };

  return (
    <AppLayout
      activePage={activePage}
      title="Agent 工作台"
      subtitle="用自然语言安排时间，确认后写入日历"
      showCalendarControls={false}
      onNavigate={onNavigate}
      onToday={() => undefined}
      onPrev={() => undefined}
      onNext={() => undefined}
      onCreate={() => undefined}
    >
      <main className="agent-workspace-main">
        <div className="agent-chat-column">
          <AgentChatPanel variant="primary" onGenerate={generatePlan} onConfirm={confirmPlan} onRevise={revisePlan} onReject={resetRun} />
        </div>
        <AgentContextPanel events={events} onToggleDone={handleToggleDone} onOpenCalendar={() => onNavigate('calendar')} />
      </main>
      <EventModal events={events} onCreate={createEvent} onUpdate={updateEvent} onDelete={deleteEvent} />
    </AppLayout>
  );
}

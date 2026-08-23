import { AgentChatPanel } from '../features/agent/AgentChatPanel';
import { AgentContextPanel } from '../features/agent/AgentContextPanel';
import { EventModal } from '../features/calendar/EventModal';
import { useAgentRun } from '../hooks/useAgentRun';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';

interface AgentWorkspacePageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function AgentWorkspacePage({ activePage, onNavigate }: AgentWorkspacePageProps) {
  const { events, fetchEvents, createEvent, updateEvent, deleteEvent } = useCalendarEvents();
  const { generatePlan, confirmPlan, revisePlan, submitScheduleDecision, resetRun } = useAgentRun(fetchEvents);

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
      <main className="agent-workspace-main agent-planner-board">
        <div className="workspace-paperclip" aria-hidden="true" />
        <div className="workspace-sticker workspace-sticker-mint" aria-hidden="true">
          checked
        </div>
        <div className="workspace-sticker workspace-sticker-folder" aria-hidden="true">
          draft
        </div>
        <section className="agent-planner-spread" aria-label="ChronoAgent 排期工作台">
          <div className="planner-page planner-page-main">
            <div className="planner-page-tab">agent trace</div>
            <div className="agent-chat-column">
              <AgentChatPanel variant="primary" onGenerate={generatePlan} onConfirm={confirmPlan} onRevise={revisePlan} onReject={resetRun} onScheduleDecision={submitScheduleDecision} />
            </div>
          </div>
          <div className="planner-book-spine" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="planner-page planner-page-context">
            <div className="planner-page-tab">today folder</div>
            <AgentContextPanel events={events} />
          </div>
        </section>
      </main>
      <EventModal events={events} onCreate={createEvent} onUpdate={updateEvent} onDelete={deleteEvent} />
    </AppLayout>
  );
}

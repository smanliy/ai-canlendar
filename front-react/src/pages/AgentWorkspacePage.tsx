import { useEffect } from 'react';
import { Button, List, Modal } from 'antd';

import { AgentChatPanel } from '../features/agent/AgentChatPanel';
import { AgentContextPanel } from '../features/agent/AgentContextPanel';
import { EventModal } from '../features/calendar/EventModal';
import { restoreActiveAgentJob, readActiveJobInput, useAgentRun } from '../hooks/useAgentRun';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { AppLayout } from '../layouts/AppLayout';
import { agentApi } from '../services/agentApi';
import { useAgentStore } from '../stores/agentStore';
import type { AppPageKey } from '../layouts/Sidebar';

interface AgentWorkspacePageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

export function AgentWorkspacePage({ activePage, onNavigate }: AgentWorkspacePageProps) {
  const { events, fetchEvents, createEvent, updateEvent, deleteEvent } = useCalendarEvents();
  const {
    generatePlan,
    forceComplexPlan,
    stopAgentRun,
    confirmPlan,
    annotateSelectedText,
    submitScheduleDecision,
    resumeActiveJobStream,
    refreshLatestUndoable,
    undoAgentRun,
    resetRun,
    pendingEventSelection,
    resolvePendingEventSelection,
    dismissPendingEventSelection,
    pendingEventConflict,
    resolvePendingEventConflict
  } = useAgentRun(fetchEvents);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [messages, activeJobs] = await Promise.all([agentApi.listConversationMessages(), agentApi.getActiveJobs()]);
        if (cancelled) return;
        if (useAgentStore.getState().conversationMessages.length === 0) {
          useAgentStore.getState().hydrateConversationMessages(messages);
        }

        // 恢复优先级：waiting_user（决策卡）> running（续看）> paused_manual（仅提示，输入"继续"恢复）
        const waiting = activeJobs.find((item) => item.job.status === 'waiting_user' && item.checkpoint?.status === 'pending');
        const running = activeJobs.find((item) => ['queued', 'running'].includes(item.job.status));
        const paused = activeJobs.find((item) => item.job.status === 'paused_manual');

        if (waiting) {
          useAgentStore.getState().setResumableJob(waiting);
          restoreActiveAgentJob(waiting);
          return;
        }

        if (running) {
          useAgentStore.getState().setResumableJob(null);
          restoreActiveAgentJob(running);
          // 重新订阅 SSE 续看（同时取消 BFF 侧 30 秒宽限期内的待执行删除）
          const prompt = readActiveJobInput(running);
          void resumeActiveJobStream(running.job.id, prompt);
          return;
        }

        if (paused) {
          // 只登记为可恢复任务，不自动恢复现场；用户输入"继续"时才恢复
          useAgentStore.getState().setResumableJob(paused);
        }
      } catch (error) {
        console.error('[Agent Workspace] initial hydrate failed:', error);
      } finally {
        if (!cancelled) {
          // 撤回按钮数据：最新可撤回轮次
          void refreshLatestUndoable();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              <AgentChatPanel
                variant="primary"
                onGenerate={generatePlan}
                onForceComplexPlan={forceComplexPlan}
                onStop={stopAgentRun}
                onConfirm={confirmPlan}
                onAnnotateText={annotateSelectedText}
                onReject={resetRun}
                onScheduleDecision={submitScheduleDecision}
                onUndoRun={undoAgentRun}
                pendingEventConflict={pendingEventConflict}
                onResolveEventConflict={resolvePendingEventConflict}
              />
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

      <Modal
        open={pendingEventSelection !== null}
        title={pendingEventSelection?.message ?? '请选择日程'}
        onCancel={dismissPendingEventSelection}
        footer={[
          <Button key="cancel" onClick={dismissPendingEventSelection}>
            取消
          </Button>
        ]}
        destroyOnClose
      >
        <List
          dataSource={pendingEventSelection?.options ?? []}
          rowKey={(option) => option.eventId}
          renderItem={(option) => (
            <List.Item
              actions={[
                <Button
                  key="pick"
                  type="primary"
                  size="small"
                  onClick={() => void resolvePendingEventSelection(option.eventId)}
                >
                  选这条
                </Button>
              ]}
            >
              <List.Item.Meta title={`「${option.title}」`} description={option.timeText} />
            </List.Item>
          )}
        />
      </Modal>
    </AppLayout>
  );
}

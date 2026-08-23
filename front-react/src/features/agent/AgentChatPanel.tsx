import { CheckCircleFilled, CloseCircleFilled, GlobalOutlined, LoadingOutlined, SendOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Space } from 'antd';

import { useAgentStore } from '../../stores/agentStore';
import type { LocalCalendarEvent } from '../../types/agent';
import { PlanOptionDeck } from './PlanOptionDeck';

interface AgentChatPanelProps {
  onGenerate: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onRevise: () => Promise<void>;
  onReject: () => void;
  onScheduleDecision: (decision: { optionId: string; taskId: string }) => Promise<void>;
  variant?: 'compact' | 'primary';
}

const statusLabel = {
  pending: 'pending',
  running: 'Loading',
  success: 'success',
  failed: 'failed'
};

const statusIcon = {
  pending: <span className="agent-step-dot" />,
  running: <LoadingOutlined className="agent-step-loading" />,
  success: <CheckCircleFilled className="agent-step-success" />,
  failed: <CloseCircleFilled className="agent-step-failed" />
};

interface ResearchSource {
  title?: string;
  url?: string;
  snippet?: string;
  tool?: string;
  query?: string;
  provider?: string;
}

function trimText(value: string | undefined, maxLength: number) {
  const text = (value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function readResearchSources(output: unknown): ResearchSource[] {
  if (!output || typeof output !== 'object' || !('researchSources' in output)) return [];
  const value = (output as { researchSources?: unknown }).researchSources;
  return Array.isArray(value) ? (value as ResearchSource[]) : [];
}

function readStepMessage(output: unknown): string {
  if (!output || typeof output !== 'object' || !('message' in output)) return '';
  const value = (output as { message?: unknown }).message;
  return typeof value === 'string' ? value : '';
}

function readCalendarEvents(output: unknown): { events: LocalCalendarEvent[]; errors: string[]; args: { startIso?: string; endIso?: string } } {
  if (!output || typeof output !== 'object' || !('calendarEventsResult' in output)) return { events: [], errors: [], args: {} };
  const value = (output as { calendarEventsResult?: unknown }).calendarEventsResult;
  if (!value || typeof value !== 'object') return { events: [], errors: [], args: {} };
  const events = (value as { events?: unknown }).events;
  const errors = (value as { errors?: unknown }).errors;
  const args = (value as { args?: unknown }).args;
  const startIso = args && typeof args === 'object' && typeof (args as { startIso?: unknown }).startIso === 'string' ? (args as { startIso: string }).startIso : undefined;
  const endIso = args && typeof args === 'object' && typeof (args as { endIso?: unknown }).endIso === 'string' ? (args as { endIso: string }).endIso : undefined;
  return {
    events: Array.isArray(events) ? (events as LocalCalendarEvent[]) : [],
    errors: Array.isArray(errors) ? errors.map(String) : [],
    args: { startIso, endIso }
  };
}

function formatCalendarTime(value: string | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(date)
    .replace(/\//g, '-');
}

function formatCalendarRange(output: unknown) {
  const { args } = readCalendarEvents(output);
  if (!args.startIso || !args.endIso) return '查询范围：未返回';
  return `查询范围：${formatCalendarTime(args.startIso)} - ${formatCalendarTime(args.endIso)}`;
}

function readFreeWindowsJson(output: unknown) {
  if (!output || typeof output !== 'object' || !('freeWindowsResult' in output)) return '';
  const value = (output as { freeWindowsResult?: unknown }).freeWindowsResult;
  if (!value || typeof value !== 'object') return '';
  return JSON.stringify(value, null, 2);
}

function readScheduleResult(output: unknown) {
  if (!output || typeof output !== 'object' || !('scheduleToolResult' in output)) return null;
  const value = (output as { scheduleToolResult?: unknown }).scheduleToolResult;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readScheduleInterrupt(output: unknown) {
  const value = readScheduleResult(output);
  const interrupt = value?.interrupt;
  if (!interrupt || typeof interrupt !== 'object') return null;
  const options = (interrupt as { options?: unknown }).options;
  return {
    reason: typeof (interrupt as { reason?: unknown }).reason === 'string' ? (interrupt as { reason: string }).reason : '',
    taskId: typeof (interrupt as { taskId?: unknown }).taskId === 'string' ? (interrupt as { taskId: string }).taskId : '',
    taskTitle: typeof (interrupt as { taskTitle?: unknown }).taskTitle === 'string' ? (interrupt as { taskTitle: string }).taskTitle : '',
    options: Array.isArray(options) ? (options as Array<{ id?: string; title?: string; description?: string }>) : []
  };
}

function readScheduleErrors(output: unknown) {
  const value = readScheduleResult(output);
  const errors = value?.errors;
  return Array.isArray(errors) ? errors.map(String).filter(Boolean) : [];
}

function readSplitSummary(output: unknown) {
  if (!output || typeof output !== 'object' || !('splitResult' in output)) return '';
  const value = (output as { splitResult?: unknown }).splitResult;
  if (!value || typeof value !== 'object') return '';
  const parent = typeof (value as { parentTaskTitle?: unknown }).parentTaskTitle === 'string' ? (value as { parentTaskTitle: string }).parentTaskTitle : '';
  const titles = Array.isArray((value as { subtaskTitles?: unknown }).subtaskTitles) ? ((value as { subtaskTitles: unknown[] }).subtaskTitles).map(String).filter(Boolean) : [];
  if (!parent || titles.length === 0) return '';
  const rounds = typeof (value as { autoSplitRounds?: unknown }).autoSplitRounds === 'number' ? (value as { autoSplitRounds: number }).autoSplitRounds : 1;
  return `检测到有任务无法放入当前黄金时间，已自动拆分 ${rounds} 个任务，并重新生成排期草稿。`;
}

function readSplitDetailLines(output: unknown) {
  if (!output || typeof output !== 'object' || !('splitResult' in output)) return [];
  const value = (output as { splitResult?: unknown }).splitResult;
  if (!value || typeof value !== 'object') return [];
  const batches = Array.isArray((value as { splitBatches?: unknown }).splitBatches) ? (value as { splitBatches: unknown[] }).splitBatches : [value];
  const lines: string[] = [];
  for (const batch of batches) {
    if (!batch || typeof batch !== 'object') continue;
    const record = batch as Record<string, unknown>;
    const parent = typeof record.parentTaskTitle === 'string' ? record.parentTaskTitle : '';
    const subtasks = Array.isArray(record.subtasks) ? record.subtasks : [];
    if (!parent || subtasks.length === 0) continue;
    lines.push(`「${parent}」已拆分为：`);
    for (const task of subtasks) {
      if (!task || typeof task !== 'object') continue;
      const taskRecord = task as Record<string, unknown>;
      const title = typeof taskRecord.title === 'string' ? taskRecord.title : '';
      const minutes = typeof taskRecord.plannedMinutes === 'number' ? taskRecord.plannedMinutes : Number(taskRecord.plannedMinutes || 0);
      if (!title) continue;
      lines.push(`- ${title}${Number.isFinite(minutes) && minutes > 0 ? `（${Math.round(minutes)}分钟）` : ''}`);
    }
  }
  return lines.slice(0, 18);
}

function formatScheduleDateTime(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(date)
    .replace(/\//g, '-');
}

function readDraftAllocationLines(output: unknown) {
  const value = readScheduleResult(output);
  const allocations = value?.draftAllocations;
  if (!Array.isArray(allocations)) return [];
  return allocations
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title : '';
      const start = formatScheduleDateTime(record.startIso);
      const end = formatScheduleDateTime(record.endIso);
      const minutes = typeof record.plannedMinutes === 'number' ? record.plannedMinutes : Number(record.plannedMinutes || 0);
      if (!title || !start || !end) return '';
      return `${start} - ${end}｜${title}${Number.isFinite(minutes) && minutes > 0 ? `（${Math.round(minutes)}分钟）` : ''}`;
    })
    .filter(Boolean);
}

function readDraftAllocationSummary(output: unknown) {
  const lines = readDraftAllocationLines(output);
  if (lines.length === 0) return [];
  const visible = lines.slice(0, 4);
  if (lines.length > visible.length) {
    visible.push(`还有 ${lines.length - visible.length} 个任务已排入草稿。`);
  }
  return visible;
}

function readScheduleStatus(output: unknown) {
  const value = readScheduleResult(output);
  const status = value?.status;
  if (typeof status !== 'string' || status === 'pending') return '等待 Python 排期工具返回结果';
  if (status === 'needsDecision') {
    const interrupt = value?.interrupt;
    if (interrupt && typeof interrupt === 'object' && (interrupt as { type?: unknown }).type === 'task_needs_non_golden_approval') {
      return '需要确认是否允许使用非黄金时间';
    }
    if (interrupt && typeof interrupt === 'object' && (interrupt as { type?: unknown }).type === 'task_exceeds_available_window') {
      return '连续空闲时间不足，需要用户选择下一步';
    }
    return '黄金时间不足，需要用户选择下一步';
  }
  if (status === 'ready') return '排期工具已生成排期草稿，下面展示时间段安排';
  const errors = readScheduleErrors(output);
  return errors.length > 0 ? `排期工具处理失败：${errors.join('；')}` : '排期工具处理失败';
}

export function AgentChatPanel({ onGenerate, onConfirm, onRevise, onReject, onScheduleDecision, variant = 'compact' }: AgentChatPanelProps) {
  const userInput = useAgentStore((state) => state.userInput);
  const submittedInput = useAgentStore((state) => state.submittedInput);
  const revisionInput = useAgentStore((state) => state.revisionInput);
  const runStatus = useAgentStore((state) => state.runStatus);
  const steps = useAgentStore((state) => state.steps);
  const planOptions = useAgentStore((state) => state.planOptions);
  const selectedPlanId = useAgentStore((state) => state.selectedPlanId);
  const conflicts = useAgentStore((state) => state.conflicts);
  const clarification = useAgentStore((state) => state.clarification);
  const clarificationInput = useAgentStore((state) => state.clarificationInput);
  const directAnswer = useAgentStore((state) => state.directAnswer);
  const confirmLoading = useAgentStore((state) => state.confirmLoading);
  const setUserInput = useAgentStore((state) => state.setUserInput);
  const setRevisionInput = useAgentStore((state) => state.setRevisionInput);
  const setClarificationInput = useAgentStore((state) => state.setClarificationInput);
  const selectPlan = useAgentStore((state) => state.selectPlan);
  const loading = runStatus === 'running';
  const hasVisibleAgentSteps = steps.some((step) => step.status !== 'pending');
  const visibleClarificationReasons = clarification
    ? clarification.reasons.filter((reason) => {
        if (reason.includes('duration') && clarificationInput.duration?.trim()) return false;
        if (reason.includes('deadline') && clarificationInput.deadline?.trim()) return false;
        return true;
      })
    : [];

  return (
    <section className={`panel-block agent-chat-panel ${variant === 'primary' ? 'agent-chat-primary' : ''}`}>
      <div className="panel-title-row">
        <h3>AI 排期对话</h3>
        <span>{runStatus === 'idle' ? '待输入' : runStatus}</span>
      </div>

      <div className="chat-window">
        <div className="chat-message assistant">
          <strong>ChronoAgent</strong>
          <p>告诉我你的目标、截止时间、花费时间和偏好。我会在拆解子任务时判断信息是否足够。</p>
        </div>

        {runStatus === 'idle' && !userInput && !submittedInput ? (
          <div className="agent-empty-scene" aria-hidden="true">
            <div className="agent-scene-note note-a">focus</div>
            <div className="agent-scene-note note-b">plan</div>
            <div className="agent-scene-person">
              <span className="agent-scene-head" />
              <span className="agent-scene-body" />
              <span className="agent-scene-arm arm-left" />
              <span className="agent-scene-arm arm-right" />
            </div>
            <div className="agent-scene-desk">
              <span className="agent-scene-laptop" />
              <span className="agent-scene-paper" />
              <span className="agent-scene-pencil" />
            </div>
            <div className="agent-scene-timebar">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}

        {submittedInput ? (
          <div className="chat-message user">
            <strong>你</strong>
            <p>{submittedInput}</p>
          </div>
        ) : null}

        {directAnswer ? (
          <div className="chat-message assistant">
            <strong>ChronoAgent</strong>
            <p>{directAnswer}</p>
          </div>
        ) : null}

        {runStatus !== 'idle' && !directAnswer && hasVisibleAgentSteps ? (
          <div className="chat-message assistant">
            <strong>ChronoAgent</strong>
            <div className="agent-step-list">
              {steps.map((step) => (
                <div className="agent-step-block" key={step.id}>
                  <button className="agent-step-row" type="button">
                    {statusIcon[step.status]}
                    <span>{step.name}</span>
                    <em>{statusLabel[step.status]}</em>
                  </button>

                  {step.id === 'step-2' && step.status !== 'pending' && !clarification ? (
                    <div className="agent-tool-trace-panel">
                      <p>{readStepMessage(step.output) || (step.status === 'running' ? '正在调用 Python Agent 工具查询外部资料' : '等待工具查询结果')}</p>
                      {readResearchSources(step.output).length > 0 ? (
                        <div className="agent-tool-trace-list">
                          {readResearchSources(step.output).map((source, sourceIndex) => (
                            <a
                              className="agent-tool-trace-item"
                              href={source.url}
                              key={`${source.url ?? source.title}-${sourceIndex}`}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <GlobalOutlined />
                              <span>
                                {source.query ? <em>搜索“{trimText(source.query, 36)}”</em> : null}
                                <strong>{trimText(source.title || source.url, 48)}</strong>
                                {source.url ? <small>{trimText(source.url, 58)}</small> : null}
                                {source.snippet ? <small>{trimText(source.snippet, 86)}</small> : null}
                              </span>
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {step.id === 'step-3' && step.status !== 'pending' ? (
                    <div className="agent-tool-trace-panel">
                      <p>{readStepMessage(step.output) || '已查询用户本地日程'}</p>
                      <div className="agent-calendar-range">{formatCalendarRange(step.output)}</div>
                      {readCalendarEvents(step.output).errors.length > 0 ? (
                        <ul className="agent-calendar-error-list">
                          {readCalendarEvents(step.output).errors.map((error) => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="agent-calendar-event-list">
                        {readCalendarEvents(step.output).events.length > 0 ? (
                          readCalendarEvents(step.output).events.map((event, eventIndex) => (
                            <div className="agent-calendar-event-item" key={`${event.id ?? event.title}-${eventIndex}`}>
                              <strong>{event.title || '未命名日程'}</strong>
                              <span>
                                {formatCalendarTime(event.startAt || event.startTime)} - {formatCalendarTime(event.endAt || event.endTime)}
                              </span>
                              <small>
                                {(event.category || '未分类')}/{event.priority || '未设置'} · {event.status || '未知状态'} · {event.source || 'unknown'}
                              </small>
                            </div>
                          ))
                        ) : (
                          <div className="agent-calendar-empty">当前查询范围内没有已有日程。</div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {step.id === 'step-4' && step.status !== 'pending' ? (
                    <div className="agent-tool-trace-panel">
                      <p>{readStepMessage(step.output) || '已计算空闲时间'}</p>
                      <pre className="agent-json-result-box">{readFreeWindowsJson(step.output) || '{\n  "freeWindows": [],\n  "errors": ["空闲时间结果未返回"]\n}'}</pre>
                    </div>
                  ) : null}

                  {step.id === 'step-5' && step.status !== 'pending' ? (
                    <div className="agent-tool-trace-panel">
                      <p>{readStepMessage(step.output) || '已生成排期草稿'}</p>
                      <div className="agent-schedule-status-box">{readScheduleStatus(step.output)}</div>
                      {readScheduleErrors(step.output).length > 0 ? (
                        <ul className="agent-calendar-error-list">
                          {readScheduleErrors(step.output).map((error) => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      ) : null}
                      {readSplitSummary(step.output) ? <div className="agent-split-summary">{readSplitSummary(step.output)}</div> : null}
                      {readSplitDetailLines(step.output).length > 0 ? (
                        <div className="agent-split-detail-list">
                          {readSplitDetailLines(step.output).map((line, lineIndex) => (
                            <div className={`agent-split-detail-item ${line.startsWith('-') ? 'child' : 'parent'}`} key={`${line}-${lineIndex}`}>
                              {line}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {readDraftAllocationSummary(step.output).length > 0 ? (
                        <div className="agent-draft-allocation-list">
                          {readDraftAllocationSummary(step.output).map((line) => (
                            <div className="agent-draft-allocation-item" key={line}>
                              {line}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {readScheduleInterrupt(step.output) ? (
                        <div className="agent-decision-panel">
                          <div className="agent-decision-copy">
                            <strong>{readScheduleInterrupt(step.output)?.taskTitle || '当前子任务需要用户决策'}</strong>
                            <span>{readScheduleInterrupt(step.output)?.reason}</span>
                          </div>
                          <div className="agent-decision-card-grid">
                            {readScheduleInterrupt(step.output)?.options.map((option) => (
                              <button
                                className="agent-decision-card"
                                key={option.id}
                                type="button"
                                onClick={() =>
                                  void onScheduleDecision({
                                    optionId: option.id || '',
                                    taskId: readScheduleInterrupt(step.output)?.taskId || readScheduleInterrupt(step.output)?.taskTitle || ''
                                  })
                                }
                              >
                                <strong>{option.title}</strong>
                                <span>{option.description}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {step.id === 'step-7' && planOptions.length > 0 ? (
                    <div className="agent-tool-trace-panel agent-plan-confirm-panel">
                      <p>我生成了多个排期方案，请选择一个确认写入日历。</p>
                      {conflicts.length > 0 ? <Alert type="warning" showIcon message={`检测到 ${conflicts.length} 个时间冲突`} /> : null}
                      <PlanOptionDeck
                        plans={planOptions}
                        selectedPlanId={selectedPlanId}
                        confirmLoading={confirmLoading}
                        onSelectPlan={selectPlan}
                        onConfirm={onConfirm}
                        onRevise={onRevise}
                        onReject={onReject}
                      />
                      <Space className="chat-plan-actions" wrap>
                        <Input.TextArea
                          rows={3}
                          value={revisionInput}
                          onChange={(event) => setRevisionInput(event.target.value)}
                          placeholder="输入修改意见，例如：周三晚上不要安排，尽量放到周末上午"
                        />
                        <Button onClick={() => void onRevise()} disabled={confirmLoading || loading}>
                          提交修改意见并重新生成
                        </Button>
                      </Space>
                    </div>
                  ) : null}

                  {step.id === 'step-1' && clarification ? (
                    <div className="clarification-inline-panel">
                      <p>{clarification.message}</p>
                      {visibleClarificationReasons.length > 0 ? (
                        <ul>
                          {visibleClarificationReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                      {Object.values(clarificationInput).some((value) => value.trim()) ? <p className="clarification-hint">已填写的字段会在提交后重新校验。</p> : null}
                      <div className="clarification-field-list">
                        {Object.keys(clarification.clarificationJson).map((field) => (
                          <label className="clarification-field-row" key={field}>
                            <span>{field}</span>
                            <Input
                              value={clarificationInput[field] ?? ''}
                              onChange={(event) => setClarificationInput(field, event.target.value)}
                              disabled={loading}
                              placeholder={field === 'duration' ? '例如：30分钟 / 半小时 / 2h' : '例如：下周五上午9点 / 明天晚上'}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

      </div>

      <div className="chat-input-area">
        <Input.TextArea
          value={userInput}
          onChange={(event) => setUserInput(event.target.value)}
          rows={3}
          placeholder="例如：下周五前完成开题报告，花费 10 小时，每天晚上 7 点后安排"
          disabled={loading}
        />
        <Button className="agent-send-button" type="primary" icon={<SendOutlined />} loading={loading} onClick={() => void onGenerate()}>
          {loading ? 'Agent 正在工作...' : clarification ? '提交补充信息' : '发送'}
        </Button>
      </div>
    </section>
  );
}

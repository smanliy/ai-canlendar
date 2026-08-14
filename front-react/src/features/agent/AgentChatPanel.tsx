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

export function AgentChatPanel({ onGenerate, onConfirm, onRevise, onReject, variant = 'compact' }: AgentChatPanelProps) {
  const userInput = useAgentStore((state) => state.userInput);
  const revisionInput = useAgentStore((state) => state.revisionInput);
  const runStatus = useAgentStore((state) => state.runStatus);
  const steps = useAgentStore((state) => state.steps);
  const planOptions = useAgentStore((state) => state.planOptions);
  const selectedPlanId = useAgentStore((state) => state.selectedPlanId);
  const conflicts = useAgentStore((state) => state.conflicts);
  const clarification = useAgentStore((state) => state.clarification);
  const clarificationInput = useAgentStore((state) => state.clarificationInput);
  const confirmLoading = useAgentStore((state) => state.confirmLoading);
  const setUserInput = useAgentStore((state) => state.setUserInput);
  const setRevisionInput = useAgentStore((state) => state.setRevisionInput);
  const setClarificationInput = useAgentStore((state) => state.setClarificationInput);
  const selectPlan = useAgentStore((state) => state.selectPlan);
  const loading = runStatus === 'running';
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

        {userInput ? (
          <div className="chat-message user">
            <strong>你</strong>
            <p>{userInput}</p>
          </div>
        ) : null}

        {runStatus !== 'idle' ? (
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

        {planOptions.length > 0 ? (
          <div className="chat-message assistant">
            <strong>ChronoAgent</strong>
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
      </div>

      <div className="chat-input-area">
        <Input.TextArea
          value={userInput}
          onChange={(event) => setUserInput(event.target.value)}
          rows={3}
          placeholder="例如：下周五前完成开题报告，花费 10 小时，每天晚上 7 点后安排"
          disabled={loading}
        />
        <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={() => void onGenerate()}>
          {loading ? 'Agent 正在工作...' : clarification ? '提交补充信息' : '发送'}
        </Button>
      </div>
    </section>
  );
}

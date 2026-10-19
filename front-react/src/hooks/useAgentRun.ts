import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';

import { agentApi, createInitialSteps, type ActiveAgentJob, type AgentStreamEvent, type ConversationMessagePayload, type EventSelectionOptionView, type PendingEventConflictView, type SchedulePlanResult } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import { useAgentStore } from '../stores/agentStore';
import { dispatchAgentJobCreated, dispatchAgentTokenMetricsCleared } from '../utils/agentJobEvents';
import type { PlanTextAnnotationPayload } from '../features/agent/PlanOptionDeck';
import type { AgentJobDetail, AgentRunStep, CalendarEventsToolResult, ConflictCheckResult, FreeWindowsToolResult, ScheduleToolResult } from '../types/agent';
import type { EventPayload } from '../types/event';

const TYPEWRITER_DELAY_MS = 28;
const RESTORED_STEP_NAMES = ['解析用户输入', '判断是否拆分', '查询已有日程', '计算空闲时间', '生成排期方案', '检测冲突', '等待用户确认', '执行写入日历'];

/** "继续"关键词：仅完整匹配才触发恢复流程，"继续帮我排考研计划"等带后缀的视为新任务 */

/** checkpoint 失效类错误（服务端 409 结构化错误的文案），用于前端自动降级 */
const CHECKPOINT_ERROR_PATTERN = /找不到可恢复|找不到可回滚|确认节点已|该确认节点/;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readScheduleResult(value: unknown): SchedulePlanResult | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (typeof status !== 'string') return null;
  if (!['needsUserInput', 'waitingConfirm', 'commandResult', 'llmAnswer', 'autoCreated', 'needsSelection', 'needsConflictResolution'].includes(status)) return null;
  return value as SchedulePlanResult;
}

function readJobResult(job: AgentJobDetail): SchedulePlanResult | null {
  const direct = readScheduleResult(job.result);
  if (direct) return direct;
  if (!job.checkpoint) return null;
  const snapshot = job.checkpoint.stateSnapshot;
  if (!isRecord(snapshot)) return null;
  return readScheduleResult(snapshot.result);
}

function readNestedStatus(value: unknown): string {
  if (!isRecord(value)) return '';
  return typeof value.status === 'string' ? value.status : '';
}

function ensureConversationMessage(message: ConversationMessagePayload) {
  const store = useAgentStore.getState();
  const exists = store.conversationMessages.some(
    (item) =>
      item.role === message.role &&
      item.runId === message.runId &&
      item.kind === message.kind &&
      item.content === message.content
  );
  if (!exists) {
    store.appendConversationMessage(message);
  }
}

function buildRestoredSteps(result: SchedulePlanResult): AgentRunStep[] {
  const now = new Date().toISOString();
  const steps: AgentRunStep[] = RESTORED_STEP_NAMES.map((name, index) => ({
    id: `step-${index + 1}`,
    name,
    status: 'pending',
    input: { index: index + 1 },
    output: null,
    createdAt: now,
    updatedAt: now
  }));

  const setStep = (stepId: string, status: AgentRunStep['status'], output?: unknown) => {
    const step = steps.find((item) => item.id === stepId);
    if (!step) return;
    step.status = status;
    if (output !== undefined) step.output = output;
    step.updatedAt = new Date().toISOString();
  };

  if (result.status === 'needsUserInput') {
    setStep('step-1', 'running', {
      message: result.message,
      reasons: result.reasons,
      clarificationJson: result.clarificationJson
    });
    return steps;
  }

  if (result.status === 'waitingConfirm') {
    setStep('step-1', 'success', { message: '用户输入已解析' });
    setStep('step-2', 'success', { message: '已判断需要继续排期' });
    setStep('step-3', 'success', { message: '已查询用户本地日程', calendarEventsResult: result.calendarEventsToolResult, agentTrace: result.agentTrace });
    setStep('step-4', 'success', { message: '已根据本地日程和用户偏好计算空闲时间', freeWindowsResult: result.freeWindowsToolResult, agentTrace: result.agentTrace });

    const scheduleStatus = readNestedStatus(result.scheduleToolResult);
    const conflictStatus = readNestedStatus(result.conflictCheckResult);

    if (scheduleStatus === 'pending' || scheduleStatus === 'needsDecision') {
      setStep('step-5', 'running', {
        message:
          scheduleStatus === 'needsDecision'
            ? '当前子任务需要用户选择三个方案之一后继续排期'
            : '排期工具仍在等待结果',
        scheduleToolResult: result.scheduleToolResult,
        agentTrace: result.agentTrace
      });
      return steps;
    }

    setStep('step-5', 'success', { message: '已调用 Python 排期工具生成草稿方案', scheduleToolResult: result.scheduleToolResult, agentTrace: result.agentTrace });

    if (conflictStatus === 'pending' || conflictStatus === 'needsDecision') {
      setStep('step-6', 'running', {
        message: conflictStatus === 'needsDecision' ? '检测到未确认冲突，需要处理后才能继续' : '冲突检测仍在等待结果',
        conflictCheckResult: result.conflictCheckResult,
        agentTrace: result.agentTrace
      });
      return steps;
    }

    setStep('step-6', 'success', { message: result.conflicts.length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突', conflictCheckResult: result.conflictCheckResult, agentTrace: result.agentTrace });
    setStep('step-7', 'running', {
      runId: result.runId,
      status: result.plans.length > 0 ? '等待用户选择方案' : '等待用户确认排期处理方式'
    });
    return steps;
  }

  if (result.status === 'autoCreated') {
    setStep('step-1', 'success', { message: '用户输入已解析' });
    setStep('step-2', 'success', { message: '已判断需要继续排期' });
    setStep('step-3', 'success', { message: '已查询用户本地日程', calendarEventsResult: result.calendarEventsToolResult, agentTrace: result.agentTrace });
    setStep('step-4', 'success', { message: '已根据本地日程和用户偏好计算空闲时间', freeWindowsResult: result.freeWindowsToolResult, agentTrace: result.agentTrace });
    setStep('step-5', 'success', { message: '已生成并写入单项排期', scheduleToolResult: result.scheduleToolResult, agentTrace: result.agentTrace });
    setStep('step-6', 'success', { message: '未检测到冲突', conflictCheckResult: result.conflictCheckResult, agentTrace: result.agentTrace });
    setStep('step-7', 'success', { runId: result.runId, status: '已完成' });
    setStep('step-8', 'success', { createdCount: result.createdCount });
    return steps;
  }

  return steps;
}

function buildRunningRestoreSteps(message = 'Agent 正在后台继续执行，请稍后刷新或等待完成') {
  const steps = createInitialSteps();
  const step = steps.find((item) => item.id === 'step-1');
  if (step) {
    step.status = 'running';
    step.output = { message };
    step.updatedAt = new Date().toISOString();
  }
  return steps;
}

export function restoreAgentRunFromJob(job: AgentJobDetail): boolean {
  const result = readJobResult(job);

  const store = useAgentStore.getState();
  const input = isRecord(job.input) && typeof job.input.input === 'string' ? job.input.input : '';
  if (input) {
    ensureConversationMessage({
      role: 'user',
      content: input,
      kind: 'userInput',
      runId: job.runId
    });
  }
  if (!result) {
    if (job.status !== 'running') return false;
    store.setCurrentRunId(job.runId);
    store.setSubmittedInput(input);
    store.setUserInput('');
    store.setRunStatus('running');
    store.setClarification(null);
    store.setDirectAnswer(null);
    store.setConfirmLoading(false);
    store.setSteps(buildRunningRestoreSteps());
    store.setPlanOptions([], []);
    store.selectPlan(null);
    return true;
  }
  store.setCurrentRunId(result.runId);
  store.setSubmittedInput(input);
  store.setUserInput('');
  store.setRunStatus(result.status === 'needsUserInput' ? 'needsUserInput' : 'waitingConfirm');
  store.setClarification(null);
  store.setDirectAnswer(null);
  store.setConfirmLoading(false);
  store.setSteps(buildRestoredSteps(result));

  if (result.status === 'needsUserInput') {
    store.setClarification({
      message: result.message,
      reasons: result.reasons,
      clarificationJson: result.clarificationJson
    });
    store.setPlanOptions([], []);
    store.selectPlan(null);
    return true;
  }

  if (result.status === 'waitingConfirm') {
    store.setPlanOptions(result.plans, result.conflicts);
    store.selectPlan(null);
    return true;
  }

  if (result.status === 'autoCreated') {
    store.setPlanOptions([result.plan], []);
    store.selectPlan(result.plan.id);
    return true;
  }

  return false;
}

function appendAndPersistConversationMessage(message: ConversationMessagePayload) {
  useAgentStore.getState().appendConversationMessage(message);
  void agentApi.saveConversationMessage(message).catch((error) => {
    console.error('[Agent Conversation] save message failed:', error);
  });
}

/** 把 /agent/jobs/active 的返回结构适配成 restoreAgentRunFromJob 需要的 AgentJobDetail */
function activeJobToDetail(active: ActiveAgentJob): AgentJobDetail {
  return {
    id: active.job.id,
    runId: active.job.runId,
    userId: '',
    type: active.job.type as AgentJobDetail['type'],
    status: active.job.status as AgentJobDetail['status'],
    idempotencyKey: null,
    input: active.job.input,
    result: null,
    error: null,
    priority: 0,
    attempt: 0,
    maxAttempts: 3,
    lockedAt: null,
    lockedBy: null,
    heartbeatAt: null,
    progressUpdatedAt: null,
    maxExecutionMs: null,
    startedAt: null,
    finishedAt: null,
    createdAt: active.job.createdAt,
    updatedAt: active.job.createdAt,
    checkpoint: active.checkpoint,
    eventSummary: { eventCount: active.events.length, errorCount: 0, durationMs: 0 }
  };
}

/** 恢复一个"应恢复"的任务（waiting_user 决策卡 / paused_manual 现场） */
export function restoreActiveAgentJob(active: ActiveAgentJob): boolean {
  return restoreAgentRunFromJob(activeJobToDetail(active));
}

/** 读取 active 任务的原始输入（SSE 恢复订阅时作为 prompt） */
export function readActiveJobInput(active: ActiveAgentJob): string {
  return isRecord(active.job.input) && typeof active.job.input.input === 'string' ? active.job.input.input : '';
}

function isClearCommand(input: string) {
  return /^\/clear(?:\s|$)/i.test(input.trim());
}

function normalizeCalendarEventsResult(value: CalendarEventsToolResult | undefined) {
  return {
    events: value?.events ?? [],
    errors: value?.errors ?? [],
    args: value?.args ?? {}
  };
}

function normalizeFreeWindowsResult(value: FreeWindowsToolResult | undefined) {
  return {
    tool: value?.tool ?? 'calculate_free_windows',
    args: value?.args ?? {},
    freeWindows: value?.freeWindows ?? [],
    totalFreeMinutes: value?.totalFreeMinutes ?? 0,
    errors: value?.errors ?? []
  };
}

function normalizeScheduleResult(value: ScheduleToolResult | undefined) {
  return {
    tool: value?.tool ?? 'schedule_tasks',
    status: value?.status ?? 'pending',
    draftAllocations: value?.draftAllocations ?? [],
    remainingFreeWindows: value?.remainingFreeWindows ?? [],
    interrupt: value?.interrupt ?? null,
    errors: value?.errors ?? []
  };
}

function normalizeConflictCheckResult(value: ConflictCheckResult | undefined) {
  return {
    tool: value?.tool ?? 'check_schedule_conflicts',
    status: value?.status ?? 'pending',
    summary: value?.summary ?? { blocking: 0, approved: 0, total: 0 },
    conflicts: value?.conflicts ?? [],
    errors: value?.errors ?? []
  };
}

function readOutputObject(output: unknown): Record<string, unknown> {
  return output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
}

function readOutputMessage(output: unknown, fallback: string): string {
  const value = readOutputObject(output).message;
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function withMessage(output: unknown, message: string) {
  return {
    ...readOutputObject(output),
    message
  };
}

async function typeStepOutput(
  stepId: string,
  status: AgentRunStep['status'],
  output: unknown,
  fallbackMessage: string,
  updateStep: (stepId: string, status: AgentRunStep['status'], output?: unknown) => void
) {
  const fullMessage = readOutputMessage(output, fallbackMessage);
  const baseOutput = readOutputObject(output);

  updateStep(stepId, 'running', { message: '' });
  for (let index = 1; index <= fullMessage.length; index += 1) {
    updateStep(stepId, 'running', { message: fullMessage.slice(0, index) });
    await sleep(TYPEWRITER_DELAY_MS);
  }
  updateStep(stepId, status, { ...baseOutput, message: fullMessage });
}

async function typeDirectAnswer(answer: string, setDirectAnswer: (answer: string | null) => void) {
  setDirectAnswer('');
  for (let index = 1; index <= answer.length; index += 1) {
    setDirectAnswer(answer.slice(0, index));
    await sleep(TYPEWRITER_DELAY_MS);
  }
}

function applyFinalResult(result: SchedulePlanResult, prompt: string) {
  const { setCurrentRunId, setPlanOptions, setRunStatus, setClarification, setSubmittedInput, clearClarification } = useAgentStore.getState();

  if (result.status === 'needsUserInput') {
    setCurrentRunId(result.runId);
    setClarification({
      message: result.message,
      reasons: result.reasons,
      clarificationJson: result.clarificationJson
    });
    appendAndPersistConversationMessage({
      role: 'assistant',
      content: result.message,
      kind: 'agentSummary',
      runId: result.runId
    });
    setRunStatus('needsUserInput');
    return;
  }

  if (result.status === 'waitingConfirm') {
    setCurrentRunId(result.runId);
    clearClarification();
    setPlanOptions(result.plans, result.conflicts);
    appendAndPersistConversationMessage({
      role: 'assistant',
      content: result.plans.length > 0 ? `已生成 ${result.plans.length} 个排期方案，等待你选择后写入日历。` : '当前排期需要你先确认处理方式。',
      kind: 'agentSummary',
      runId: result.runId
    });
    return;
  }

  if (result.status === 'llmAnswer') {
    useAgentStore.getState().setCurrentRunId(result.runId);
    setSubmittedInput(prompt);
    useAgentStore.getState().setRunStatus('success');
    return;
  }

  if (result.status === 'needsSelection') {
    // 日程定位歧义：问题文本已随 directAnswer 进聊天流，这里只收尾状态；
    // 候选弹框由 generatePlan / 页面根据返回值渲染
    useAgentStore.getState().setCurrentRunId(result.runId);
    setSubmittedInput(prompt);
    useAgentStore.getState().setRunStatus('success');
    return;
  }

  if (result.status === 'needsConflictResolution') {
    // 时间冲突挂起：冲突说明已随 directAnswer 进聊天流，这里只收尾状态；
    // 冲突决策卡由 generatePlan / 页面根据返回值渲染
    useAgentStore.getState().setCurrentRunId(result.runId);
    setSubmittedInput(prompt);
    useAgentStore.getState().setRunStatus('success');
    return;
  }

  if (result.status === 'autoCreated') {
    useAgentStore.getState().setCurrentRunId(result.runId);
    setSubmittedInput(prompt);
    useAgentStore.getState().setRunStatus('success');
    return;
  }

  if (result.status === 'commandResult') {
    useAgentStore.getState().setRunStatus('success');
  }
}

type StreamMessageApi = { success: (content: string) => void };

/**
 * 订阅某个 Agent job 的 SSE 事件流并驱动 store 更新。
 * 从 generatePlan 中抽出：generatePlan（新任务）和页面重开恢复（running 任务续看）共用同一套事件处理。
 */
async function streamAgentJobToStore(
  jobId: string,
  prompt: string,
  signal: AbortSignal | undefined,
  messageApi: StreamMessageApi
): Promise<SchedulePlanResult | null> {
  let eventQueue = Promise.resolve();
  let latestFinalResult: SchedulePlanResult | null = null;

  const enqueue = (handler: () => Promise<void> | void) => {
    eventQueue = eventQueue.then(handler);
    return eventQueue;
  };

  const handleJobEvent = async (eventName: string, payload: unknown) => {
    const store = useAgentStore.getState();
    const record = (payload && typeof payload === 'object' ? payload : {}) as {
      stepId?: string | null;
      message?: string | null;
      payload?: unknown;
      command?: 'clear' | 'compact';
      summary?: string;
      status?: string;
      result?: SchedulePlanResult | null;
    };
    const nested = record.payload && typeof record.payload === 'object' ? (record.payload as Record<string, unknown>) : null;

    if (eventName === 'step:start') {
      store.updateStep(record.stepId ?? 'step-1', 'running', record.message ? { message: record.message } : undefined);
      return;
    }

    if (eventName === 'step:update') {
      const output = nested?.output ?? (record.message ? { message: record.message, payload: record.payload } : record.payload);
      store.updateStep(record.stepId ?? 'step-1', 'running', output);
      return;
    }

    if (eventName === 'step:success') {
      const output = nested?.output ?? (record.message ? { message: record.message, payload: record.payload } : record.payload);
      await typeStepOutput(record.stepId ?? 'step-1', 'success', output, '当前步骤已完成', store.updateStep);
      return;
    }

    if (eventName === 'step:failed') {
      const output = nested?.output ?? (record.message ? { message: record.message, payload: record.payload } : record.payload);
      await typeStepOutput(record.stepId ?? 'step-1', 'failed', output, '当前步骤需要补充信息或处理失败', store.updateStep);
      return;
    }

    if (eventName === 'direct:answer') {
      const answer = typeof nested?.answer === 'string' ? nested.answer : typeof record.message === 'string' ? record.message : '';
      if (!answer) return;
      store.resetRun();
      store.setSubmittedInput(prompt);
      store.setRunStatus('running');
      await typeDirectAnswer(answer, store.setDirectAnswer);
      appendAndPersistConversationMessage({
        role: 'assistant',
        content: answer,
        kind: 'directAnswer'
      });
      store.setDirectAnswer(null);
      store.setRunStatus('success');
      return;
    }

    if (eventName === 'command:result') {
      const command = (nested?.command as 'clear' | 'compact' | undefined) ?? record.command;
      const messageText = typeof nested?.message === 'string' ? nested.message : record.message ?? '';
      const summaryText = typeof nested?.summary === 'string' ? nested.summary : record.summary;
      if (command === 'clear') {
        await agentApi.clearConversationMessages();
        store.clearConversation();
        dispatchAgentTokenMetricsCleared();
        messageApi.success(messageText || '已清空会话');
        return;
      }
      store.resetRun();
      store.setSubmittedInput(prompt);
      store.setRunStatus('running');
      const commandContent = summaryText ? `${messageText}\n\n${summaryText}`.trim() : messageText;
      await typeDirectAnswer(commandContent, store.setDirectAnswer);
      appendAndPersistConversationMessage({
        role: 'assistant',
        content: commandContent,
        kind: 'command'
      });
      store.setDirectAnswer(null);
      store.setRunStatus('success');
      messageApi.success(messageText || '命令已执行');
      return;
    }

    if (eventName === 'final') {
      const finalResult = (nested?.data as SchedulePlanResult | undefined) ?? (record.payload as { data?: SchedulePlanResult } | undefined)?.data;
      if (finalResult) {
        latestFinalResult = finalResult;
      }
      return;
    }

    if (eventName === 'job:succeeded' || eventName === 'job:waiting_user') {
      const finalResult = record.result ?? (nested as SchedulePlanResult | null) ?? (record.payload as SchedulePlanResult | undefined) ?? null;
      if (finalResult) {
        latestFinalResult = finalResult;
      }
      return;
    }

    if (eventName === 'job:state') {
      if (record.status === 'succeeded' || record.status === 'waiting_user') {
        const finalResult = record.result ?? null;
        if (finalResult) {
          latestFinalResult = finalResult;
        }
      }
      return;
    }

    if (eventName === 'job:failed') {
      throw new Error(record.message ?? 'Agent job failed');
    }

    if (eventName === 'error') {
      throw new Error(record.message ?? 'Agent job stream failed');
    }
  };

  await agentApi.streamJobEvents(jobId, (eventName, payload) => enqueue(() => handleJobEvent(eventName, payload)), signal);
  await eventQueue;
  return latestFinalResult;
}

export function useAgentRun(onEventsCreated: () => Promise<void> | void) {
  const { message, modal } = AntApp.useApp();
  const activeJobControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  // 日程定位歧义的候选弹框（三级定位第 3 级）：非空时页面渲染选项 Modal
  const [pendingEventSelection, setPendingEventSelection] = useState<{
    message: string;
    options: EventSelectionOptionView[];
    pendingOperation: {
      kind: 'event_update' | 'event_delete';
      target?: Record<string, unknown>;
      patch?: Record<string, unknown>;
      allowConflict?: boolean;
    };
  } | null>(null);
  // 快速路径时间冲突的决策卡（主 agent 同款样式）：非空时聊天面板渲染决策卡
  const [pendingEventConflict, setPendingEventConflict] = useState<PendingEventConflictView | null>(null);

  /**
   * 用户在冲突决策卡上做出选择后回传 BFF：
   * 保留冲突 / 把冲突日程后移 N 分钟（用户可编辑）/ 取消。
   */
  const resolvePendingEventConflict = useCallback(
    async (action: 'keep_conflict' | 'shift_existing' | 'cancel', shiftMinutes?: number) => {
      const pending = pendingEventConflict;
      if (!pending) return;
      setPendingEventConflict(null);
      try {
        const result = await agentApi.resolveEventConflict({
          action,
          shiftMinutes,
          conflictEventIds: pending.conflicts.map((conflict) => conflict.eventId),
          operation: pending.pendingOperation
        });
        appendAndPersistConversationMessage({
          role: 'assistant',
          content: result.answer,
          kind: 'directAnswer'
        });
        message.success(result.answer);
        await onEventsCreated();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '时间冲突决策执行失败');
      }
    },
    [pendingEventConflict, message, onEventsCreated]
  );

  const dismissPendingEventConflict = useCallback(() => {
    setPendingEventConflict(null);
  }, []);

  /**
   * 用户在选项框点定某条日程后：带着 eventId 回传 BFF 重跑该改/删操作。
   */
  const resolvePendingEventSelection = useCallback(
    async (eventId: string) => {
      const pending = pendingEventSelection;
      if (!pending) return;
      setPendingEventSelection(null);
      try {
        const result = await agentApi.resolveEventSelection({ eventId, operation: pending.pendingOperation });
        appendAndPersistConversationMessage({
          role: 'assistant',
          content: result.answer,
          kind: 'directAnswer'
        });
        message.success(result.answer);
        await onEventsCreated();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '日程选择执行失败');
      }
    },
    [pendingEventSelection, message, onEventsCreated]
  );

  const dismissPendingEventSelection = useCallback(() => {
    setPendingEventSelection(null);
  }, []);

  // 异常退出守卫：pagehide 时若仍有进行中的任务，发 beacon 通知 BFF 延迟清理。
  // 只监听 pagehide（关闭标签页/跳转外部），不监听 visibilitychange（切标签页不是退出）。
  useEffect(() => {
    const handler = () => {
      const { currentJobId } = useAgentStore.getState();
      if (currentJobId) {
        agentApi.sendJobAbortBeacon(currentJobId);
      }
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, []);

  const stopAgentRun = useCallback(async () => {
    const { currentJobId, setCurrentJobId, setRunStatus, updateStep } = useAgentStore.getState();
    if (!currentJobId) {
      message.info('当前任务还在创建或已经结束');
      return;
    }

    stopRequestedRef.current = true;
    activeJobControllerRef.current?.abort();
    try {
      const result = await agentApi.cancelJob(currentJobId);
      const runningStepId = useAgentStore.getState().steps.find((step) => step.status === 'running')?.id ?? 'step-1';
      updateStep(runningStepId, 'failed', {
        message: result.checkpoint ? '已终止当前生成，并保存了可恢复业务断点' : '已终止当前生成，但当前阶段尚未形成可恢复业务断点'
      });
      setRunStatus('idle');
      setCurrentJobId(null);
      message.info(result.checkpoint ? '已终止，已保存断点' : '已终止，当前阶段暂无可恢复断点');
    } catch (error) {
      stopRequestedRef.current = false;
      message.error(error instanceof Error ? error.message : '终止 Agent 任务失败');
    }
  }, [message]);

  const generatePlan = useCallback(
    async (overrideInput?: string) => {
      const { userInput, submittedInput, clarification, clarificationInput, startRun, setCurrentJobId, resumableJob, setResumableJob, setUserInput } = useAgentStore.getState();
      const typedPrompt = (overrideInput ?? userInput).trim();
      // 澄清表单提交场景：startRun 已清空输入框，userInput 为空，
      // 此时用户点"提交补充信息"是在回答上一轮的追问——用原始输入 submittedInput 重发，
      // 而不是报"请先输入排期目标"直接返回（用户看到的就是"点了没反应"）。
      const prompt = typedPrompt || (clarification ? submittedInput.trim() : '');
      const isSilentClarifyResubmit = !typedPrompt && Boolean(clarification) && Boolean(prompt);
      if (!prompt) {
        message.warning('请先输入排期目标');
        return;
      }

      // "继续"类语义不再由前端关键词判断：原样发给 BFF，
      // 由 BFF 的 LLM 意图识别器决定是 resume_pending（恢复上次任务）还是其他意图。

      const parsedClarification = clarification ? clarificationInput : undefined;

      const runId = `run-${Date.now()}`;
      stopRequestedRef.current = false;
      activeJobControllerRef.current?.abort();
      activeJobControllerRef.current = new AbortController();
      startRun(runId, prompt);
      setResumableJob(null);
      if (!isClearCommand(prompt) && !isSilentClarifyResubmit) {
        appendAndPersistConversationMessage({
          role: 'user',
          content: prompt,
          kind: 'userInput',
          runId
        });
      }

      try {
        const createdJob = await agentApi.createJob({ input: prompt, clarificationJson: parsedClarification });
        dispatchAgentJobCreated(createdJob);
        useAgentStore.getState().setCurrentRunId(createdJob.runId);
        setCurrentJobId(createdJob.id);
        const streamController = activeJobControllerRef.current;
        if (!streamController) throw new Error('Agent stream controller missing');
        const streamResult = await streamAgentJobToStore(createdJob.id, prompt, streamController.signal, message);
        const result = streamResult ?? (await agentApi.getJob(createdJob.id)).result;
        if (!result) throw new Error('队列任务结束但未返回结果');
        applyFinalResult(result as SchedulePlanResult, prompt);

        const finalResult = result as SchedulePlanResult;
        if (finalResult.status === 'needsUserInput') {
          message.warning('信息还不够明确，请在下方卡片中补全后再提交');
          return;
        }

        if (finalResult.status === 'needsSelection') {
          // 日程定位歧义：弹出候选选项框让用户点选
          setPendingEventSelection({
            message: finalResult.message,
            options: finalResult.options,
            pendingOperation: finalResult.pendingOperation
          });
          return;
        }

        if (finalResult.status === 'needsConflictResolution') {
          // 时间冲突挂起：弹出主 agent 同款冲突决策卡让用户选择处理方式
          setPendingEventConflict({
            message: finalResult.message,
            conflicts: finalResult.conflicts,
            suggestedShiftMinutes: finalResult.suggestedShiftMinutes,
            pendingOperation: finalResult.pendingOperation
          });
          return;
        }

        if (finalResult.status === 'autoCreated') {
          message.success(finalResult.message);
          await onEventsCreated();
          return;
        }

        if (finalResult.status === 'waitingConfirm') {
          if (finalResult.plans.length > 0) {
            message.success(`已生成 ${finalResult.plans.length} 个排期方案`);
          } else {
            message.info('当前排期需要先确认处理方式');
          }
        }
      } catch (err) {
        if (stopRequestedRef.current) {
          return;
        }
        const failedStep = useAgentStore.getState().steps.find((step) => step.status === 'running')?.id ?? 'step-1';
        useAgentStore.getState().updateStep(failedStep, 'failed', { message: err instanceof Error ? err.message : 'Agent 生成方案失败' });
        useAgentStore.getState().setRunStatus('failed');
        message.error(err instanceof Error ? err.message : 'Agent 生成方案失败');
      } finally {
        activeJobControllerRef.current = null;
        useAgentStore.getState().setCurrentJobId(null);
        stopRequestedRef.current = false;
      }
    },
    [message]
  );

  const forceComplexPlan = useCallback(async () => {
    const { submittedInput, userInput } = useAgentStore.getState();
    const source = (submittedInput || userInput).trim();
    if (!source) {
      message.warning('没有可重新规划的原始需求');
      return;
    }
    const prompt = `${source}\n用户纠错：这不是简单日程或直接回答，请按复杂排期 Agent 流程重新规划。`;
    appendAndPersistConversationMessage({
      role: 'user',
      content: '这不是我想要的，转复杂规划',
      kind: 'agentCorrection',
      payload: {
        sourceInput: source,
        forcedRoute: 'new_task'
      }
    });
    await generatePlan(prompt);
  }, [generatePlan, message]);

  const annotateSelectedText = useCallback(
    async (payload: PlanTextAnnotationPayload) => {
      const { currentRunId, setPlanOptions } = useAgentStore.getState();
      if (!payload.comment.trim()) {
        message.warning('请先输入批注意见');
        return;
      }
      if (!currentRunId) {
        message.warning('当前没有可修改的 Agent 方案');
        return;
      }

      try {
        const result = await agentApi.submitAnnotation(currentRunId, payload);
        setPlanOptions(result.plans, result.conflicts);
        message.success('已按批注局部更新方案');
      } catch (error) {
        message.error(error instanceof Error ? error.message : '批注局部更新失败');
      }
    },
    [message, onEventsCreated]
  );

  const submitScheduleDecision = useCallback(
    async (decision: { optionId: string; taskId: string }) => {
      const { currentRunId, updateStep, setPlanOptions } = useAgentStore.getState();
      if (!currentRunId) {
        message.warning('当前没有可恢复的 Agent 任务');
        return;
      }
      if (!['split_task', 'allow_beyond_golden_time'].includes(decision.optionId)) {
        message.info('这个选项的继续执行逻辑下一步接入');
        return;
      }
      const isAllowBeyondGoldenTime = decision.optionId === 'allow_beyond_golden_time';
      const runningMessage = isAllowBeyondGoldenTime ? '正在允许该任务使用非黄金时间并重新排期' : '正在局部拆分该子任务并重新排期';
      const successMessage = isAllowBeyondGoldenTime ? '已允许该任务使用非黄金时间，并重新生成排期草稿' : '已完成局部拆分并重新生成排期草稿';
      const toastMessage = isAllowBeyondGoldenTime ? '已记录本次超出黄金时间的用户确认' : '已只替换当前大子任务，并重新生成方案';
      const errorMessage = isAllowBeyondGoldenTime ? '允许使用非黄金时间失败' : '继续拆分失败';
      try {
        updateStep('step-5', 'running', { message: runningMessage });
        const result = await agentApi.submitDecision(currentRunId, decision);
        updateStep('step-5', 'success', {
          message: successMessage,
          scheduleToolResult: normalizeScheduleResult(result.scheduleToolResult),
          splitResult: result.splitResult,
          agentTrace: result.agentTrace
        });
        updateStep('step-6', 'success', {
          message: result.conflicts.length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突',
          conflictCheckResult: normalizeConflictCheckResult(result.conflictCheckResult),
          agentTrace: result.agentTrace
        });
        setPlanOptions(result.plans, result.conflicts);
        updateStep('step-7', 'success', {
          runId: currentRunId,
          status: result.plans.length > 0 ? '等待用户选择方案' : '等待用户确认排期处理方式'
        });
        if (result.plans.length > 0) {
          message.success(toastMessage);
        } else {
          message.info('当前排期仍需要继续确认处理方式');
        }
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : errorMessage;
        updateStep('step-5', 'failed', { message: errMessage });
        // P0 修复：checkpoint 缺失/失效（异常退出残留的旧 runId）→ 自动降级，重置现场让用户重新发起
        if (CHECKPOINT_ERROR_PATTERN.test(errMessage)) {
          message.warning('上次的任务已失效，已为你重置，请重新发起排期');
          useAgentStore.getState().resetRun();
          useAgentStore.getState().setResumableJob(null);
          return;
        }
        message.error(errMessage);
      }
    },
    [message]
  );

  /** 刷新"最新可撤回轮次"（BFF GET /events/agent-runs/latest） */
  const refreshLatestUndoable = useCallback(async () => {
    try {
      const latest = await eventApi.getLatestAgentRun();
      useAgentStore.getState().setLatestUndoableRun(latest);
    } catch {
      // 静默失败：撤回按钮只是增强能力，不能影响主流程
    }
  }, []);

  const confirmPlan = useCallback(async () => {
    const { currentRunId, planOptions, selectedPlanId, setConfirmLoading, updateStep, setRunStatus } = useAgentStore.getState();
    const selectedPlan = planOptions.find((item) => item.id === selectedPlanId);

    if (!selectedPlan || !currentRunId) {
      message.warning('请先选择一个方案');
      return;
    }

    setConfirmLoading(true);
    try {
      updateStep('step-8', 'running');
      await agentApi.confirm(currentRunId);
      const payloads: EventPayload[] = selectedPlan.items.map((item) => {
        const [start, end] = item.timeRange.split(' - ');
        return {
          title: item.title,
          startTime: `${item.date}T${start}:00+08:00`,
          endTime: `${item.date}T${end}:00+08:00`,
          category: item.category,
          priority: item.priority,
          status: '未开始',
          note: `由 Agent Run ${currentRunId} 写入`
        };
      });
      await eventApi.bulkCreateEvents(payloads, currentRunId);
      updateStep('step-8', 'success', { created: payloads.length });
      appendAndPersistConversationMessage({
        role: 'assistant',
        content: `已写入日历，共创建 ${payloads.length} 条日程。本轮排期已结束。`,
        kind: 'agentSummary',
        runId: currentRunId
      });
      message.success('已写入日历');
      await onEventsCreated();
      // 本轮已写入日历 → 刷新"最新可撤回轮次"，气泡下方出现撤回按钮
      await refreshLatestUndoable();
      useAgentStore.getState().resetRun();
    } catch (err) {
      updateStep('step-8', 'failed');
      setRunStatus('failed');
      message.error(err instanceof Error ? err.message : '写入日历失败');
    } finally {
      useAgentStore.getState().setConfirmLoading(false);
    }
  }, [message, onEventsCreated, refreshLatestUndoable]);

  /** 撤回某轮写入的日历（仅最新一轮可撤；撤回后上一轮自动成为最新，支持连锁） */
  const undoAgentRun = useCallback(
    async (runId: string) => {
      const { latestUndoableRun, markRunRevoked } = useAgentStore.getState();
      if (!latestUndoableRun || latestUndoableRun.runId !== runId) {
        message.warning('只能撤回最近一次操作');
        return;
      }
      const eventCount = latestUndoableRun.eventCount;
      modal.confirm({
        title: '撤回本次操作',
        content: `将删除本轮创建的 ${eventCount} 个日程事件，且不可恢复。`,
        okText: '撤回',
        okType: 'danger',
        cancelText: '取消',
        onOk: async () => {
          try {
            const result = await eventApi.undoAgentRunEvents(runId);
            markRunRevoked(runId);
            message.success(`已撤回本轮写入的 ${result.affectedCount} 条日程`);
            await refreshLatestUndoable();
            await onEventsCreated();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '撤回失败');
          }
        }
      });
    },
    [message, modal, onEventsCreated, refreshLatestUndoable]
  );

  /**
   * 页面重开恢复（P1）：running/queued 任务重新订阅 SSE 续看。
   * 复用 streamAgentJobToStore 的事件处理，结束后走 applyFinalResult。
   */
  const resumeActiveJobStream = useCallback(
    async (jobId: string, prompt: string) => {
      stopRequestedRef.current = false;
      activeJobControllerRef.current?.abort();
      activeJobControllerRef.current = new AbortController();
      useAgentStore.getState().setCurrentJobId(jobId);
      const controller = activeJobControllerRef.current;
      try {
        const streamResult = await streamAgentJobToStore(jobId, prompt, controller.signal, message);
        if (stopRequestedRef.current) return;
        const result = streamResult ?? (await agentApi.getJob(jobId)).result;
        if (result) {
          applyFinalResult(result as SchedulePlanResult, prompt);
        }
      } catch (err) {
        if (stopRequestedRef.current) return;
        const failedStep = useAgentStore.getState().steps.find((step) => step.status === 'running')?.id ?? 'step-1';
        useAgentStore.getState().updateStep(failedStep, 'failed', { message: err instanceof Error ? err.message : '恢复任务流失败' });
        useAgentStore.getState().setRunStatus('failed');
        message.error(err instanceof Error ? err.message : '恢复任务流失败');
      } finally {
        activeJobControllerRef.current = null;
        useAgentStore.getState().setCurrentJobId(null);
        stopRequestedRef.current = false;
      }
    },
    [message]
  );

  return {
    generatePlan,
    forceComplexPlan,
    stopAgentRun,
    annotateSelectedText,
    confirmPlan,
    submitScheduleDecision,
    resumeActiveJobStream,
    refreshLatestUndoable,
    undoAgentRun,
    resetRun: useAgentStore.getState().resetRun,
    setUserInput: useAgentStore.getState().setUserInput,
    selectPlan: useAgentStore.getState().selectPlan,
    pendingEventSelection,
    resolvePendingEventSelection,
    dismissPendingEventSelection,
    pendingEventConflict,
    resolvePendingEventConflict,
    dismissPendingEventConflict
  };
}

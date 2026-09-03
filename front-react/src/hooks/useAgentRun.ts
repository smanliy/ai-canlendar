import { useCallback } from 'react';
import { App as AntApp } from 'antd';

import { agentApi, createInitialSteps, type AgentStreamEvent, type ConversationMessagePayload, type SchedulePlanResult } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import { useAgentStore } from '../stores/agentStore';
import { dispatchAgentJobCreated, dispatchAgentTokenMetricsCleared } from '../utils/agentJobEvents';
import type { PlanTextAnnotationPayload } from '../features/agent/PlanOptionDeck';
import type { AgentJobDetail, AgentRunStep, CalendarEventsToolResult, ConflictCheckResult, FreeWindowsToolResult, ScheduleToolResult } from '../types/agent';
import type { EventPayload } from '../types/event';

const TYPEWRITER_DELAY_MS = 28;
const RESTORED_STEP_NAMES = ['解析用户输入', '判断是否拆分', '查询已有日程', '计算空闲时间', '生成排期方案', '检测冲突', '等待用户确认', '执行写入日历'];

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readScheduleResult(value: unknown): SchedulePlanResult | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (typeof status !== 'string') return null;
  if (!['needsUserInput', 'waitingConfirm', 'commandResult', 'llmAnswer', 'autoCreated'].includes(status)) return null;
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

export function useAgentRun(onEventsCreated: () => Promise<void> | void) {
  const { message } = AntApp.useApp();
  const generatePlan = useCallback(
    async (overrideInput?: string) => {
      const { userInput, clarification, clarificationInput, startRun } = useAgentStore.getState();
      const prompt = (overrideInput ?? userInput).trim();
      if (!prompt) {
        message.warning('请先输入排期目标');
        return;
      }

      const parsedClarification = clarification ? clarificationInput : undefined;

      const runId = `run-${Date.now()}`;
      startRun(runId, prompt);
      if (!isClearCommand(prompt)) {
        appendAndPersistConversationMessage({
          role: 'user',
          content: prompt,
          kind: 'userInput',
          runId
        });
      }

      try {
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
              message.success(messageText || '已清空会话');
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
            message.success(messageText || '命令已执行');
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

        const createdJob = await agentApi.createJob({ input: prompt, clarificationJson: parsedClarification });
        dispatchAgentJobCreated(createdJob);
        useAgentStore.getState().setCurrentRunId(createdJob.runId);
        const streamPromise = agentApi.streamJobEvents(createdJob.id, (eventName, payload) => enqueue(() => handleJobEvent(eventName, payload)));
        await streamPromise;
        await eventQueue;
        const result = latestFinalResult ?? (await agentApi.getJob(createdJob.id)).result;
        if (!result) throw new Error('队列任务结束但未返回结果');
        applyFinalResult(result as SchedulePlanResult, prompt);

        const finalResult = result as SchedulePlanResult;
        if (finalResult.status === 'needsUserInput') {
          message.warning('信息还不够明确，请补全 JSON 后再次发送');
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
        const failedStep = useAgentStore.getState().steps.find((step) => step.status === 'running')?.id ?? 'step-1';
        useAgentStore.getState().updateStep(failedStep, 'failed', { message: err instanceof Error ? err.message : 'Agent 生成方案失败' });
        useAgentStore.getState().setRunStatus('failed');
        message.error(err instanceof Error ? err.message : 'Agent 生成方案失败');
      }
    },
    [message]
  );

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
        updateStep('step-5', 'failed', { message: err instanceof Error ? err.message : errorMessage });
        message.error(err instanceof Error ? err.message : errorMessage);
      }
    },
    [message]
  );

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
      useAgentStore.getState().resetRun();
    } catch (err) {
      updateStep('step-8', 'failed');
      setRunStatus('failed');
      message.error(err instanceof Error ? err.message : '写入日历失败');
    } finally {
      useAgentStore.getState().setConfirmLoading(false);
    }
  }, [message, onEventsCreated]);

  return {
    generatePlan,
    annotateSelectedText,
    confirmPlan,
    submitScheduleDecision,
    resetRun: useAgentStore.getState().resetRun,
    setUserInput: useAgentStore.getState().setUserInput,
    selectPlan: useAgentStore.getState().selectPlan
  };
}


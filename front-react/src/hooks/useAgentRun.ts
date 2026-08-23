import { useCallback } from 'react';
import { App as AntApp } from 'antd';

import { agentApi, type AgentStreamEvent, type SchedulePlanResult } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import { useAgentStore } from '../stores/agentStore';
import type { AgentRunStep, CalendarEventsToolResult, ConflictCheckResult, FreeWindowsToolResult, ScheduleToolResult } from '../types/agent';
import type { EventPayload } from '../types/event';

const TYPEWRITER_DELAY_MS = 28;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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
    setRunStatus('needsUserInput');
    return;
  }

  if (result.status === 'waitingConfirm') {
    setCurrentRunId(result.runId);
    clearClarification();
    setPlanOptions(result.plans, result.conflicts);
    return;
  }

  if (result.status === 'llmAnswer') {
    useAgentStore.getState().setCurrentRunId(result.runId);
    setSubmittedInput(prompt);
    useAgentStore.getState().setRunStatus('success');
    return;
  }

  if (result.status === 'commandResult') {
    if (result.command === 'clear') {
      useAgentStore.getState().resetRun();
      return;
    }
    useAgentStore.getState().setRunStatus('success');
  }
}

export function useAgentRun(onEventsCreated: () => Promise<void> | void) {
  const { message } = AntApp.useApp();
  const generatePlan = useCallback(
    async (overrideInput?: string) => {
      const { userInput, clarification, clarificationInput, startRun, updateStep, setRunStatus, setDirectAnswer } = useAgentStore.getState();
      const prompt = (overrideInput ?? userInput).trim();
      if (!prompt) {
        message.warning('请先输入排期目标');
        return;
      }

      const parsedClarification = clarification ? clarificationInput : undefined;

      const runId = `run-${Date.now()}`;
      startRun(runId, prompt);

      try {
        let eventQueue = Promise.resolve();
        let latestFinalResult: SchedulePlanResult | null = null;

        const enqueue = (handler: () => Promise<void> | void) => {
          eventQueue = eventQueue.then(handler);
          return eventQueue;
        };

        const handleEvent = async (event: AgentStreamEvent) => {
          const store = useAgentStore.getState();
          if (event.type === 'stepStarted') {
            store.updateStep(event.stepId, 'running', event.message ? { message: event.message } : undefined);
            return;
          }

          if (event.type === 'stepSucceeded') {
            await typeStepOutput(event.stepId, 'success', event.output, '当前步骤已完成', store.updateStep);
            return;
          }

          if (event.type === 'stepFailed') {
            await typeStepOutput(event.stepId, 'failed', event.output, '当前步骤需要补充信息或处理失败', store.updateStep);
            return;
          }

          if (event.type === 'directAnswer') {
            store.resetRun();
            store.setSubmittedInput(prompt);
            store.setRunStatus('running');
            await typeDirectAnswer(event.answer, store.setDirectAnswer);
            store.setRunStatus('success');
            return;
          }

          if (event.type === 'commandResult') {
            if (event.command === 'clear') {
              store.resetRun();
            } else {
              store.resetRun();
              store.setSubmittedInput(prompt);
              store.setRunStatus('running');
              await typeDirectAnswer(event.summary ? `${event.message}\n\n${event.summary}` : event.message, store.setDirectAnswer);
              store.setRunStatus('success');
            }
            message.success(event.message);
            return;
          }

          if (event.type === 'final') {
            latestFinalResult = event.data;
            applyFinalResult(event.data, prompt);
            return;
          }

          if (event.type === 'error') {
            throw new Error(event.message);
          }
        };

        const result = await agentApi.schedulePlanStream(prompt, parsedClarification, (event) => enqueue(() => handleEvent(event)));
        await eventQueue;
        applyFinalResult(latestFinalResult ?? result, prompt);

        const finalResult = latestFinalResult ?? result;
        if (finalResult.status === 'needsUserInput') {
          message.warning('信息还不够明确，请补全 JSON 后再次发送');
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

  const revisePlan = useCallback(async () => {
    const { submittedInput, userInput, revisionInput, setRevisionInput } = useAgentStore.getState();
    if (!revisionInput.trim()) {
      message.warning('请先输入修改意见');
      return;
    }
    const baseInput = submittedInput || userInput;
    const combinedInput = `${baseInput}\n修改意见：${revisionInput}`;
    setRevisionInput('');
    await generatePlan(combinedInput);
  }, [generatePlan, message]);

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
          splitResult: result.splitResult
        });
        updateStep('step-6', 'success', {
          message: result.conflicts.length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突',
          conflictCheckResult: normalizeConflictCheckResult(result.conflictCheckResult)
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
    revisePlan,
    confirmPlan,
    submitScheduleDecision,
    resetRun: useAgentStore.getState().resetRun,
    setUserInput: useAgentStore.getState().setUserInput,
    setRevisionInput: useAgentStore.getState().setRevisionInput,
    selectPlan: useAgentStore.getState().selectPlan
  };
}


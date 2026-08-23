import { useCallback } from 'react';
import { App as AntApp } from 'antd';

import { agentApi } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import { useAgentStore } from '../stores/agentStore';
import type { CalendarEventsToolResult, ConflictCheckResult, FreeWindowsToolResult, SchedulePlanOption, ScheduleToolResult } from '../types/agent';
import type { EventPayload } from '../types/event';

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function collectResearchSources(plans: SchedulePlanOption[]) {
  const seen = new Set<string>();
  return plans
    .flatMap((plan) => plan.items)
    .flatMap((item) => item.evidence ?? [])
    .filter((source) => {
      const key = `${source.query ?? ''}|${source.url ?? ''}|${source.title ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(source.query || source.url || source.title);
    })
    .slice(0, 8);
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

export function useAgentRun(onEventsCreated: () => Promise<void> | void) {
  const { message } = AntApp.useApp();
  const generatePlan = useCallback(
    async (overrideInput?: string) => {
      const { userInput, clarification, clarificationInput, startRun, setCurrentRunId, updateStep, setPlanOptions, setRunStatus, setClarification, clearClarification } = useAgentStore.getState();
      const prompt = (overrideInput ?? userInput).trim();
      if (!prompt) {
        message.warning('请先输入排期目标');
        return;
      }

      const parsedClarification = clarification ? clarificationInput : undefined;

      const runId = `run-${Date.now()}`;
      startRun(runId);

      try {
        updateStep('step-1', 'running');
        const result = await agentApi.schedulePlan(prompt, parsedClarification);
        if (result.status === 'needsUserInput') {
          setCurrentRunId(result.runId);
          setClarification({
            message: result.message,
            reasons: result.reasons,
            clarificationJson: result.clarificationJson
          });
          updateStep('step-1', 'failed', { message: result.message, reasons: result.reasons });
          setRunStatus('needsUserInput');
          message.warning('信息还不够明确，请补全 JSON 后再次发送');
          return;
        }

        setCurrentRunId(result.runId);
        updateStep('step-1', 'success', { message: '用户输入已解析' });
        updateStep('step-2', 'success', {
          message: '子任务拆解完成，已查询外部资料来源',
          researchSources: collectResearchSources(result.plans)
        });

        updateStep('step-3', 'running');
        await sleep(240);
        updateStep('step-3', 'success', {
          message: '已查询用户本地日程',
          calendarEventsResult: normalizeCalendarEventsResult(result.calendarEventsToolResult)
        });

        updateStep('step-4', 'running');
        await sleep(240);
        updateStep('step-4', 'success', {
          message: '已根据本地日程和用户偏好计算空闲时间',
          freeWindowsResult: normalizeFreeWindowsResult(result.freeWindowsToolResult)
        });

        updateStep('step-5', 'running');
        await sleep(240);
        updateStep('step-5', 'success', {
          message: '已调用 Python 排期工具生成草稿方案',
          scheduleToolResult: normalizeScheduleResult(result.scheduleToolResult)
        });

        updateStep('step-6', 'running');
        await sleep(240);
        updateStep('step-6', 'success', {
          message: result.conflicts.length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突',
          conflictCheckResult: normalizeConflictCheckResult(result.conflictCheckResult)
        });

        clearClarification();
        if (result.plans.length > 0) {
          setPlanOptions(result.plans, result.conflicts);
          updateStep('step-7', 'running');
          updateStep('step-7', 'success', { runId: result.runId, status: '等待用户选择方案' });
          message.success(`已生成 ${result.plans.length} 个排期方案`);
        } else {
          setPlanOptions([], result.conflicts);
          updateStep('step-7', 'running');
          updateStep('step-7', 'success', { runId: result.runId, status: '等待用户确认排期处理方式' });
          message.info('当前排期需要先确认处理方式');
        }
      } catch (err) {
        useAgentStore.getState().updateStep('step-6', 'failed');
        useAgentStore.getState().setRunStatus('failed');
        message.error(err instanceof Error ? err.message : 'Agent 生成方案失败');
      }
    },
    [message]
  );

  const revisePlan = useCallback(async () => {
    const { userInput, revisionInput, setUserInput, setRevisionInput } = useAgentStore.getState();
    if (!revisionInput.trim()) {
      message.warning('请先输入修改意见');
      return;
    }
    const combinedInput = `${userInput}\n修改意见：${revisionInput}`;
    setUserInput(combinedInput);
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
      setRunStatus('success');
      message.success('已写入日历');
      await onEventsCreated();
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


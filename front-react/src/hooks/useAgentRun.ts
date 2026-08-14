import { useCallback } from 'react';
import { App as AntApp } from 'antd';

import { agentApi } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import { useAgentStore } from '../stores/agentStore';
import type { CalendarEventsToolResult, FreeWindowsToolResult, SchedulePlanOption } from '../types/agent';
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

export function useAgentRun(onEventsCreated: () => Promise<void> | void) {
  const { message } = AntApp.useApp();
  const generatePlan = useCallback(
    async (overrideInput?: string) => {
      const { userInput, clarification, clarificationInput, startRun, updateStep, setPlanOptions, setRunStatus, setClarification, clearClarification } = useAgentStore.getState();
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

        for (const stepId of ['step-5', 'step-6']) {
          updateStep(stepId, 'running');
          await sleep(240);
          updateStep(stepId, 'success', { message: '节点处理完成' });
        }

        clearClarification();
        setPlanOptions(result.plans, result.conflicts);
        updateStep('step-7', 'running');
        updateStep('step-7', 'success', { runId: result.runId, status: '等待用户选择方案' });
        message.success(`已生成 ${result.plans.length} 个排期方案`);
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
    resetRun: useAgentStore.getState().resetRun,
    setUserInput: useAgentStore.getState().setUserInput,
    setRevisionInput: useAgentStore.getState().setRevisionInput,
    selectPlan: useAgentStore.getState().selectPlan
  };
}


import { useCallback } from 'react';
import { App as AntApp } from 'antd';

import { agentApi } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import { useAgentStore } from '../stores/agentStore';
import type { EventPayload } from '../types/event';

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function useAgentRun(onEventsCreated: () => Promise<void> | void) {
  const { message } = AntApp.useApp();
  const generatePlan = useCallback(
    async (overrideInput?: string) => {
      const { userInput, startRun, updateStep, setPlanOptions, setRunStatus } = useAgentStore.getState();
      const prompt = (overrideInput ?? userInput).trim();
      if (!prompt) {
        message.warning('请先输入排期目标');
        return;
      }

      const runId = `run-${Date.now()}`;
      startRun(runId);

      try {
        for (const stepId of ['step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6']) {
          updateStep(stepId, 'running');
          await sleep(360);
          updateStep(stepId, 'success', { message: '节点处理完成' });
        }

        updateStep('step-7', 'running');
        const result = await agentApi.schedulePlan(prompt);
        setPlanOptions(result.plans, result.conflicts);
        updateStep('step-7', 'success', { runId: result.runId, status: '等待用户选择方案' });
        message.success('已生成 6 个排期方案');
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


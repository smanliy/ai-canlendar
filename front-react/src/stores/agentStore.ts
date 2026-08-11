import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { createInitialSteps } from '../services/agentApi';
import type { AgentConflict, AgentRunStatus, AgentRunStep, SchedulePlan, SchedulePlanOption } from '../types/agent';

interface AgentState {
  currentRunId: string | null;
  userInput: string;
  revisionInput: string;
  runStatus: AgentRunStatus;
  steps: AgentRunStep[];
  plan: SchedulePlan | null;
  planOptions: SchedulePlanOption[];
  selectedPlanId: string | null;
  conflicts: AgentConflict[];
  confirmLoading: boolean;
  setUserInput: (value: string) => void;
  setRevisionInput: (value: string) => void;
  resetRun: () => void;
  startRun: (runId: string) => void;
  updateStep: (stepId: string, status: AgentRunStep['status'], output?: unknown) => void;
  setPlan: (plan: SchedulePlan, conflicts: AgentConflict[]) => void;
  setPlanOptions: (plans: SchedulePlanOption[], conflicts: AgentConflict[]) => void;
  selectPlan: (planId: string | null) => void;
  setRunStatus: (status: AgentRunStatus) => void;
  setConfirmLoading: (loading: boolean) => void;
}

export const useAgentStore = create<AgentState>()(
  immer((set) => ({
    currentRunId: null,
    userInput: '',
    revisionInput: '',
    runStatus: 'idle',
    steps: createInitialSteps(),
    plan: null,
    planOptions: [],
    selectedPlanId: null,
    conflicts: [],
    confirmLoading: false,
    setUserInput: (value) =>
      set((state) => {
        state.userInput = value;
      }),
    setRevisionInput: (value) =>
      set((state) => {
        state.revisionInput = value;
      }),
    resetRun: () =>
      set((state) => {
        state.currentRunId = null;
        state.runStatus = 'idle';
        state.steps = createInitialSteps();
        state.plan = null;
        state.planOptions = [];
        state.selectedPlanId = null;
        state.conflicts = [];
        state.confirmLoading = false;
        state.revisionInput = '';
      }),
    startRun: (runId) =>
      set((state) => {
        state.currentRunId = runId;
        state.runStatus = 'running';
        state.steps = createInitialSteps();
        state.plan = null;
        state.planOptions = [];
        state.selectedPlanId = null;
        state.conflicts = [];
      }),
    updateStep: (stepId, status, output) =>
      set((state) => {
        const step = state.steps.find((item) => item.id === stepId);
        if (step) {
          step.status = status;
          step.output = output ?? step.output;
          step.updatedAt = new Date().toISOString();
        }
      }),
    setPlan: (plan, conflicts) =>
      set((state) => {
        state.plan = plan;
        state.planOptions = [];
        state.selectedPlanId = null;
        state.conflicts = conflicts;
        state.runStatus = 'waitingConfirm';
      }),
    setPlanOptions: (plans, conflicts) =>
      set((state) => {
        state.planOptions = plans;
        state.plan = null;
        state.selectedPlanId = null;
        state.conflicts = conflicts;
        state.runStatus = 'waitingConfirm';
      }),
    selectPlan: (planId) =>
      set((state) => {
        if (!planId) {
          state.selectedPlanId = null;
          state.plan = null;
          return;
        }
        state.selectedPlanId = planId;
        state.plan = state.planOptions.find((plan) => plan.id === planId) ?? state.plan;
      }),
    setRunStatus: (status) =>
      set((state) => {
        state.runStatus = status;
      }),
    setConfirmLoading: (loading) =>
      set((state) => {
        state.confirmLoading = loading;
      })
  }))
);

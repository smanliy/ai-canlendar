import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { createInitialSteps } from '../services/agentApi';
import type { ActiveAgentJob } from '../services/agentApi';
import type { AgentClarification, AgentConflict, AgentConversationMessage, AgentRunStatus, AgentRunStep, SchedulePlan, SchedulePlanOption } from '../types/agent';

interface LatestUndoableRun {
  runId: string;
  eventCount: number;
  createdAt?: string;
}

interface AgentState {
  currentRunId: string | null;
  currentJobId: string | null;
  userInput: string;
  submittedInput: string;
  runStatus: AgentRunStatus;
  steps: AgentRunStep[];
  plan: SchedulePlan | null;
  planOptions: SchedulePlanOption[];
  selectedPlanId: string | null;
  conflicts: AgentConflict[];
  clarification: AgentClarification | null;
  clarificationInput: Record<string, string>;
  directAnswer: string | null;
  conversationMessages: AgentConversationMessage[];
  confirmLoading: boolean;
  /** 页面重开时发现的可恢复任务（waiting_user / paused_manual），输入"继续"可恢复 */
  resumableJob: ActiveAgentJob | null;
  /** 最新可撤回轮次（只撤最新一轮；撤回后自动指向更早一轮） */
  latestUndoableRun: LatestUndoableRun | null;
  /** 已撤回的 runId，气泡上不再显示撤回按钮 */
  revokedRunIds: string[];
  setUserInput: (value: string) => void;
  setSubmittedInput: (value: string) => void;
  setSteps: (steps: AgentRunStep[]) => void;
  resetRun: () => void;
  startRun: (runId: string, submittedInput: string) => void;
  setCurrentRunId: (runId: string) => void;
  setCurrentJobId: (jobId: string | null) => void;
  updateStep: (stepId: string, status: AgentRunStep['status'], output?: unknown) => void;
  setPlan: (plan: SchedulePlan, conflicts: AgentConflict[]) => void;
  setPlanOptions: (plans: SchedulePlanOption[], conflicts: AgentConflict[]) => void;
  setClarification: (clarification: AgentClarification | null) => void;
  setDirectAnswer: (answer: string | null) => void;
  appendConversationMessage: (message: Omit<AgentConversationMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }) => void;
  hydrateConversationMessages: (messages: AgentConversationMessage[]) => void;
  clearConversation: () => void;
  setClarificationInput: (field: string, value: string) => void;
  clearClarification: () => void;
  selectPlan: (planId: string | null) => void;
  setRunStatus: (status: AgentRunStatus) => void;
  setConfirmLoading: (loading: boolean) => void;
  setResumableJob: (job: ActiveAgentJob | null) => void;
  setLatestUndoableRun: (run: LatestUndoableRun | null) => void;
  markRunRevoked: (runId: string) => void;
}

export const useAgentStore = create<AgentState>()(
  immer((set) => ({
    currentRunId: null,
    currentJobId: null,
    userInput: '',
    submittedInput: '',
    runStatus: 'idle',
    steps: createInitialSteps(),
    plan: null,
    planOptions: [],
    selectedPlanId: null,
    conflicts: [],
    clarification: null,
    clarificationInput: {},
    directAnswer: null,
    conversationMessages: [],
    confirmLoading: false,
    resumableJob: null,
    latestUndoableRun: null,
    revokedRunIds: [],
    setUserInput: (value) =>
      set((state) => {
        state.userInput = value;
      }),
    setSubmittedInput: (value) =>
      set((state) => {
        state.submittedInput = value;
      }),
    setSteps: (steps) =>
      set((state) => {
        state.steps = steps;
      }),
    resetRun: () =>
      set((state) => {
        state.currentRunId = null;
        state.currentJobId = null;
        state.runStatus = 'idle';
        state.userInput = '';
        state.submittedInput = '';
        state.steps = createInitialSteps();
        state.plan = null;
        state.planOptions = [];
        state.selectedPlanId = null;
        state.conflicts = [];
        state.clarification = null;
        state.clarificationInput = {};
        state.directAnswer = null;
        state.confirmLoading = false;
      }),
    startRun: (runId, submittedInput) =>
      set((state) => {
        state.currentRunId = runId;
        state.currentJobId = null;
        state.userInput = '';
        state.submittedInput = submittedInput;
        state.runStatus = 'running';
        state.steps = createInitialSteps();
        state.plan = null;
        state.planOptions = [];
        state.selectedPlanId = null;
        state.conflicts = [];
        state.clarification = null;
        state.clarificationInput = {};
        state.directAnswer = null;
      }),
    setCurrentRunId: (runId) =>
      set((state) => {
        state.currentRunId = runId;
      }),
    setCurrentJobId: (jobId) =>
      set((state) => {
        state.currentJobId = jobId;
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
        state.clarification = null;
        state.clarificationInput = {};
      }),
    setPlanOptions: (plans, conflicts) =>
      set((state) => {
        state.planOptions = plans;
        state.plan = null;
        state.selectedPlanId = null;
        state.conflicts = conflicts;
        state.runStatus = 'waitingConfirm';
        state.clarification = null;
        state.clarificationInput = {};
      }),
    setClarification: (clarification) =>
      set((state) => {
        state.clarification = clarification;
        state.clarificationInput = clarification
          ? Object.fromEntries(Object.entries(clarification.clarificationJson).map(([field, value]) => [field, typeof value === 'string' ? value : '']))
          : {};
        state.runStatus = clarification ? 'needsUserInput' : state.runStatus;
      }),
    setDirectAnswer: (answer) =>
      set((state) => {
        state.directAnswer = answer;
      }),
    appendConversationMessage: (message) =>
      set((state) => {
        state.conversationMessages.push({
          id: message.id ?? `${message.role}-${Date.now()}-${state.conversationMessages.length + 1}`,
          role: message.role,
          content: message.content,
          kind: message.kind,
          runId: message.runId,
          createdAt: message.createdAt ?? new Date().toISOString()
        });
      }),
    hydrateConversationMessages: (messages) =>
      set((state) => {
        state.conversationMessages = messages;
      }),
    clearConversation: () =>
      set((state) => {
        state.currentRunId = null;
        state.currentJobId = null;
        state.userInput = '';
        state.submittedInput = '';
        state.runStatus = 'idle';
        state.steps = createInitialSteps();
        state.plan = null;
        state.planOptions = [];
        state.selectedPlanId = null;
        state.conflicts = [];
        state.clarification = null;
        state.clarificationInput = {};
        state.directAnswer = null;
        state.conversationMessages = [];
        state.confirmLoading = false;
      }),
    setClarificationInput: (field, value) =>
      set((state) => {
        state.clarificationInput[field] = value;
      }),
    clearClarification: () =>
      set((state) => {
        state.clarification = null;
        state.clarificationInput = {};
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
      }),
    setResumableJob: (job) =>
      set((state) => {
        state.resumableJob = job;
      }),
    setLatestUndoableRun: (run) =>
      set((state) => {
        state.latestUndoableRun = run;
      }),
    markRunRevoked: (runId) =>
      set((state) => {
        if (!state.revokedRunIds.includes(runId)) {
          state.revokedRunIds.push(runId);
        }
        if (state.latestUndoableRun?.runId === runId) {
          state.latestUndoableRun = null;
        }
      })
  }))
);

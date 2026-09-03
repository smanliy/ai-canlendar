import { applyPlanAnnotation, resumeScheduleDecision as resumeScheduleDecisionOrchestrator } from './agent.orchestrator';
import { createHash } from 'crypto';
import { runAgentMainFlow } from './agent-main-flow';
import { createCheckpoint, findCheckpointForRollback, findCurrentCheckpoint, resolveCheckpoint } from './agent-checkpoint.repository';
import {
  appendMessage,
  estimateSessionTokens,
  getAgentTokenMetrics,
  getCompressionSettings as readCompressionSettings,
  getSession,
  recordAgentTurnContinuationTokenMetric,
  setCompressionSettings
} from './session-compression';
import * as jobRepository from './agent-job.repository';
import * as conversationRepository from './agent-conversation.repository';
import type { AgentAnnotationPayload, AgentConversationMessagePayload, AgentRollbackPayload } from './agent.schema';
import type { AgentDecisionPayload } from './agent.schema';
import { savePlanningSession, type AgentPlanningSessionState } from './agent-planning-session.repository';

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildIdempotencyKey(userId: string, action: string, payload: unknown): string {
  return createHash('sha256').update(`${userId}:${action}:${stableStringify(payload)}`).digest('hex');
}

export async function createScheduleRun(userId: string, input: string, clarificationJson?: unknown) {
  if (/^\/clear(?:\s|$)/i.test(input.trim())) {
    await clearConversationMessages(userId);
  }
  return runAgentMainFlow({
    userId,
    input,
    clarificationJson
  });
}

export async function getCompressionSettings(userId: string) {
  return readCompressionSettings(userId);
}

export async function updateCompressionSettings(userId: string, settings: { enabled: boolean }) {
  return setCompressionSettings(userId, settings);
}

export async function getTokenMetrics(userId: string) {
  return getAgentTokenMetrics(userId);
}

function recordFollowupTokenMetric(userId: string, input: { runId: string; phase: string; userText: string; assistantText: string; result: unknown }) {
  const state = getSession(userId);
  const contextTokensBefore = estimateSessionTokens(state);
  appendMessage(state, 'user', input.userText);
  appendMessage(state, 'assistant', input.assistantText);
  state.agentState = input.result;
  state.toolResults.push(input.result);
  recordAgentTurnContinuationTokenMetric(userId, {
    runId: input.runId,
    status: 'waitingConfirm',
    phase: input.phase,
    compressionEnabled: readCompressionSettings(userId).enabled,
    contextTokensBefore,
    state,
    result: input.result
  });
}

export async function createScheduleJob(userId: string, input: string, clarificationJson?: unknown, forceNew = false) {
  const payload = {
    input,
    clarificationJson
  };
  return jobRepository.createAgentJob({
    userId,
    type: 'schedule_plan',
    payload,
    idempotencyKey: forceNew ? undefined : buildIdempotencyKey(userId, 'schedule_plan', payload)
  });
}

export async function listScheduleJobs(userId: string) {
  return jobRepository.listAgentJobs(userId);
}

export async function getScheduleJob(userId: string, jobId: string) {
  const job = await jobRepository.findAgentJob(jobId, userId);
  if (!job) throw new Error('找不到当前 Agent 任务');
  const checkpoint = await findCurrentCheckpoint(job.runId, userId);
  const events = await jobRepository.listAgentJobEvents(job.id);
  const eventSummary = events.reduce(
    (summary, event) => ({
      eventCount: summary.eventCount + 1,
      errorCount: summary.errorCount + (event.level === 'error' ? 1 : 0),
      durationMs: summary.durationMs + (event.durationMs ?? 0)
    }),
    { eventCount: 0, errorCount: 0, durationMs: 0 }
  );
  return {
    ...job,
    checkpoint,
    eventSummary
  };
}

export async function listScheduleJobEvents(userId: string, jobId: string) {
  const job = await jobRepository.findAgentJob(jobId, userId);
  if (!job) throw new Error('找不到当前 Agent 任务');
  return jobRepository.listAgentJobEvents(jobId);
}

export async function cancelScheduleJob(userId: string, jobId: string) {
  await jobRepository.cancelAgentJob(jobId, userId);
}

export async function rollbackScheduleRun(userId: string, runId: string, payload: AgentRollbackPayload = {}) {
  const checkpoint = await findCheckpointForRollback({
    runId,
    userId,
    checkpointId: payload.checkpointId,
    version: payload.version
  });
  if (!checkpoint) throw new Error('找不到可回滚的 Agent 确认节点');

  const snapshot = readObject(checkpoint.stateSnapshot);
  const result = readObject(snapshot.result);
  const planningSession = readObject(snapshot.planningSession);
  if (planningSession.userId === userId && planningSession.rawInput && planningSession.userPreference && planningSession.normalizedContext && planningSession.atomicPlan) {
    await savePlanningSession(runId, planningSession as unknown as AgentPlanningSessionState, 'waitingConfirm');
  }

  const restoredCheckpoint = await createCheckpoint({
    runId,
    userId,
    type: checkpoint.type,
    stepName: checkpoint.stepName,
    prompt: `已回滚到版本 ${checkpoint.version}：${checkpoint.prompt}`,
    options: checkpoint.options,
    resumePayload: checkpoint.resumePayload,
    stateSnapshot: checkpoint.stateSnapshot,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

  return {
    runId,
    status: 'rolledBack',
    restoredFrom: {
      checkpointId: checkpoint.id,
      version: checkpoint.version
    },
    checkpoint: restoredCheckpoint,
    result: Object.keys(result).length > 0 ? result : checkpoint.stateSnapshot
  };
}

export async function createScheduleDecisionJob(userId: string, runId: string, decision: AgentDecisionPayload) {
  const checkpoint = await resolveCheckpoint({
    runId,
    userId,
    checkpointId: decision.checkpointId,
    version: decision.version
  });
  if (!checkpoint) throw new Error('找不到可恢复的 Agent 确认节点');
  return jobRepository.createAgentJob({
    userId,
    runId,
    type: 'resume_decision',
    payload: {
      runId,
      decision,
      sourceJobId: checkpoint.jobId
    },
    idempotencyKey: buildIdempotencyKey(userId, 'resume_decision', { runId, decision })
  });
}

export async function submitScheduleDecision(userId: string, runId: string, decision: AgentDecisionPayload) {
  const checkpoint = await resolveCheckpoint({
    runId,
    userId,
    checkpointId: decision.checkpointId,
    version: decision.version
  });
  if (!checkpoint) throw new Error('找不到可恢复的 Agent 确认节点');
  const result = await resumeScheduleDecisionOrchestrator(userId, runId, decision);
  if (checkpoint.jobId) {
    await jobRepository.completeAgentJob(checkpoint.jobId, result, 'succeeded');
  }
  recordFollowupTokenMetric(userId, {
    runId,
    phase: 'resumeDecision',
    userText: `用户选择排期决策：${JSON.stringify(decision)}`,
    assistantText: result.plans.length > 0 ? `已根据选择更新 ${result.plans.length} 个方案。` : '已根据选择继续恢复排期，仍需确认。',
    result
  });
  return result;
}

export async function submitPlanAnnotation(userId: string, runId: string, annotation: AgentAnnotationPayload) {
  const result = await applyPlanAnnotation(userId, runId, annotation);
  recordFollowupTokenMetric(userId, {
    runId,
    phase: 'planAnnotation',
    userText: `用户批注方案：${JSON.stringify(annotation)}`,
    assistantText: '已根据批注更新方案卡。',
    result
  });
  return result;
}

export async function listConversationMessages(userId: string) {
  return conversationRepository.listRecentConversationMessages(userId);
}

export async function saveConversationMessage(userId: string, payload: AgentConversationMessagePayload) {
  return conversationRepository.saveConversationMessage(userId, payload);
}

export async function clearConversationMessages(userId: string) {
  return conversationRepository.clearConversationMessages(userId);
}

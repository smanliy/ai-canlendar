import { applyPlanAnnotation, resumeScheduleDecision as resumeScheduleDecisionOrchestrator } from './agent.orchestrator';
import { createHash } from 'crypto';
import { runAgentMainFlow } from './agent-main-flow';
import { AgentCheckpointError, AgentJobNotFoundError } from './agent.errors';
import { createCheckpoint, findCheckpointForRollback, findCurrentCheckpoint, findPendingManualPauseCheckpoint, resolveCheckpoint, supersedeManualPauseCheckpoints } from './agent-checkpoint.repository';
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
import type { AgentAnnotationPayload, AgentConversationMessagePayload, AgentEventConflictResolutionPayload, AgentEventSelectionPayload, AgentRollbackPayload } from './agent.schema';
import type { AgentDecisionPayload } from './agent.schema';
import { executeSelectedEventOperation, resolveEventConflict as resolveEventConflictOperation } from './agent-operations';
import { findPlanningSession, savePlanningSession, type AgentPlanningSessionState } from './agent-planning-session.repository';

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
  // 注意：这里不能作废 manual_pause 断点。"继续"也走本入口建任务，
  // 若在建任务时作废断点，恢复操作（executeResumeOperation）将永远找不到可恢复现场。
  // "新任务丢弃旧任务"由 executeNewTaskOperation 里的 discardPendingManualJob 在
  // LLM 判定输入确为 new_task 之后处理（还会向用户汇报丢弃了什么），语义正确且时机正确。
  return jobRepository.createAgentJob({
    userId,
    type: 'schedule_plan',
    payload,
    idempotencyKey: forceNew ? undefined : buildIdempotencyKey(userId, 'schedule_plan', payload)
  });
}

export interface ActiveAgentJobDetail {
  job: {
    id: string;
    runId: string;
    type: string;
    status: string;
    input: unknown;
    createdAt: string;
  };
  checkpoint: unknown | null;
  events: unknown[];
}

/**
 * 页面重开恢复用：返回该用户当前所有"应恢复"的任务。
 * - queued / running：异常退出或刷新后仍在执行的任务（前端应重新订阅 SSE 续看）；
 * - waiting_user：等待用户决策的任务（决策卡原样恢复，永不过期）；
 * - pausedManual：手动终止且断点仍在 24h 有效期内（输入"继续"可恢复现场）。
 */
export async function listActiveScheduleJobs(userId: string): Promise<ActiveAgentJobDetail[]> {
  const [activeJobs, pausedCheckpoint] = await Promise.all([
    jobRepository.listAgentJobsByStatus(userId, ['queued', 'running', 'waiting_user']),
    findPendingManualPauseCheckpoint(userId)
  ]);

  const details: ActiveAgentJobDetail[] = [];
  const seenJobIds = new Set<string>();

  for (const job of activeJobs) {
    seenJobIds.add(job.id);
    const checkpoint = await findCurrentCheckpoint(job.runId, userId);
    const events = await jobRepository.listAgentJobEvents(job.id);
    details.push({
      job: {
        id: job.id,
        runId: job.runId,
        type: job.type,
        status: job.status,
        input: job.input,
        createdAt: job.createdAt instanceof Date ? job.createdAt.toISOString() : String(job.createdAt)
      },
      checkpoint,
      events
    });
  }

  if (pausedCheckpoint?.jobId && !seenJobIds.has(pausedCheckpoint.jobId)) {
    const job = await jobRepository.findAgentJob(pausedCheckpoint.jobId, userId);
    if (job) {
      details.push({
        job: {
          id: job.id,
          runId: job.runId,
          type: job.type,
          status: 'paused_manual',
          input: job.input,
          createdAt: job.createdAt instanceof Date ? job.createdAt.toISOString() : String(job.createdAt)
        },
        checkpoint: pausedCheckpoint,
        events: []
      });
    }
  }

  return details;
}

export async function listScheduleJobs(userId: string) {
  return jobRepository.listAgentJobs(userId);
}

export async function getScheduleJob(userId: string, jobId: string) {
  const job = await jobRepository.findAgentJob(jobId, userId);
  if (!job) throw new AgentJobNotFoundError();
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
  if (!job) throw new AgentJobNotFoundError();
  return jobRepository.listAgentJobEvents(jobId);
}

export async function cancelScheduleJob(userId: string, jobId: string) {
  const job = await jobRepository.findAgentJob(jobId, userId);
  if (!job) throw new AgentJobNotFoundError();

  const existingCheckpoint = await findCurrentCheckpoint(job.runId, userId);
  await jobRepository.cancelAgentJob(jobId, userId);
  await jobRepository.appendAgentJobEvent({
    jobId,
    type: 'job:canceled',
    message: '用户手动终止当前 Agent 任务',
    payload: {
      jobId,
      runId: job.runId,
      reason: 'manual_stop'
    },
    level: 'warn'
  });

  if (existingCheckpoint) {
    return {
      canceled: true,
      checkpoint: existingCheckpoint
    };
  }

  const planningSession = await findPlanningSession(job.runId, userId);
  const result = readObject(job.result);
  const hasResult = Object.keys(result).length > 0;

  if (!planningSession && !hasResult) {
    return {
      canceled: true,
      checkpoint: null
    };
  }

  // 断点唯一化：创建新的 manual_pause 断点前，作废旧的同类型 pending 断点
  await supersedeManualPauseCheckpoints(userId);

  const checkpoint = await createCheckpoint({
    runId: job.runId,
    userId,
    jobId: job.id,
    type: 'manual_pause',
    stepName: 'manual_pause',
    prompt: '用户手动终止了当前 Agent 生成，可根据已保存的业务现场决定是否继续。',
    options: [],
    resumePayload: {
      jobType: job.type,
      runId: job.runId,
      sourceJobId: job.id,
      reason: 'manual_pause'
    },
    stateSnapshot: {
      result: hasResult ? result : null,
      planningSession,
      pausedAt: new Date().toISOString()
    },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

  return {
    canceled: true,
    checkpoint
  };
}

export async function rollbackScheduleRun(userId: string, runId: string, payload: AgentRollbackPayload = {}) {
  const checkpoint = await findCheckpointForRollback({
    runId,
    userId,
    checkpointId: payload.checkpointId,
    version: payload.version
  });
  if (!checkpoint) throw new AgentCheckpointError('找不到可回滚的 Agent 确认节点', 'NO_CHECKPOINT');

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

/**
 * 用户在选项框里选定日程后，带着 eventId 重跑该改/删操作（三级定位第 3 级的闭环）。
 * 只走执行器单操作路径，不经过意图识别（操作参数已在上一步由 LLM 抽好）。
 */
export async function resolveEventSelection(userId: string, payload: AgentEventSelectionPayload) {
  // schema 校验已约束 kind/target/patch 形状；这里转成执行器的 IntentOperation
  const operation = payload.operation as unknown as import('./intent-classifier').IntentOperation;
  const execution = await executeSelectedEventOperation(userId, operation, payload.eventId);
  return {
    runId: `sel-${Date.now()}`,
    status: 'llmAnswer' as const,
    rawInput: `用户已选择日程：${payload.eventId}`,
    answer: execution.report.trim() || '操作已处理。',
    reason: 'event-selection'
  };
}

export async function resolveEventConflict(userId: string, payload: AgentEventConflictResolutionPayload) {
  const operation = payload.operation as unknown as import('./intent-classifier').IntentOperation;
  const answer = await resolveEventConflictOperation(userId, {
    action: payload.action,
    shiftMinutes: payload.shiftMinutes,
    conflictEventIds: payload.conflictEventIds,
    operation
  });
  return {
    runId: `conflict-${Date.now()}`,
    status: 'llmAnswer' as const,
    rawInput: `用户已处理时间冲突（${payload.action}）`,
    answer,
    reason: `event-conflict/${payload.action}`
  };
}

export async function createScheduleDecisionJob(userId: string, runId: string, decision: AgentDecisionPayload) {  const checkpoint = await resolveCheckpoint({
    runId,
    userId,
    checkpointId: decision.checkpointId,
    version: decision.version
  });
  if (!checkpoint) throw new AgentCheckpointError('找不到可恢复的 Agent 确认节点', 'NO_CHECKPOINT');
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
  if (!checkpoint) throw new AgentCheckpointError('找不到可恢复的 Agent 确认节点', 'NO_CHECKPOINT');
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

import type { AgentAutoCreatedResponse, AgentClarificationResponse, AgentConflictResolutionResponse, AgentCreateRunResponse, AgentEventSelectionResponse, AgentRunResponse } from './agent.types';
import {
  appendMessage,
  compactSession,
  estimateSessionTokens,
  getCompressionSettings,
  getSession,
  maybeAutoCompactSession,
  maybeMicroCompactSession,
  consumeLatestCompactionUsage,
  clearSessionState,
  recordAgentTurnTokenMetric,
  rewriteSessionWithSummary,
  type AgentCompactionEvent,
  type SchedulingSessionState
} from './session-compression';
import * as jobRepository from './agent-job.repository';
import { cancelPendingCheckpointsByUser } from './agent-checkpoint.repository';
import { clearPlanningSessionsByUser } from './agent-planning-session.repository';
import * as conversationRepository from './agent-conversation.repository';
import { classifyUserIntent, nowIsoWithOffset } from './intent-classifier';
import { buildResumeQueueContext, executeIntentOperations } from './agent-operations';

type SessionCommand = 'clear' | 'compact';

interface ParsedCommand {
  command: SessionCommand | null;
  trailingText: string;
}

interface RunMainFlowInput {
  userId: string;
  input: string;
  clarificationJson?: unknown;
  onEvent?: AgentMainFlowEventHandler;
}

export type AgentMainFlowEvent =
  | { type: 'stepStarted'; stepId: string; message?: string }
  | { type: 'stepUpdated'; stepId: string; output?: unknown }
  | { type: 'stepSucceeded'; stepId: string; output?: unknown }
  | { type: 'stepFailed'; stepId: string; output?: unknown }
  | { type: 'directAnswer'; answer: string; reason: string }
  | { type: 'commandResult'; command: SessionCommand; message: string; summary?: string }
  | { type: 'final'; data: AgentMainFlowResponse };

export type AgentMainFlowEventHandler = (event: AgentMainFlowEvent) => void | Promise<void>;

export interface AgentCommandResponse {
  runId: string;
  status: 'commandResult';
  command: SessionCommand;
  message: string;
  summary?: string;
}

export interface AgentLlmAnswerResponse {
  runId: string;
  status: 'llmAnswer';
  rawInput: string;
  answer: string;
  reason: string;
}

export type AgentMainFlowResponse = AgentCreateRunResponse | AgentCommandResponse | AgentLlmAnswerResponse;

function parseCommand(input: string): ParsedCommand {
  const match = input.trim().match(/^\/(?<command>clear|compact|compat)(?:\s+(?<text>[\s\S]*))?$/i);
  if (!match?.groups?.command) {
    return { command: null, trailingText: '' };
  }
  const rawCommand = match.groups.command.toLowerCase();
  return {
    command: rawCommand === 'clear' ? 'clear' : 'compact',
    trailingText: (match.groups.text ?? '').trim()
  };
}

function mergeAgentResultIntoState(state: SchedulingSessionState, input: string, result: AgentRunResponse | AgentClarificationResponse | AgentAutoCreatedResponse): void {
  state.currentRequest = input;
  state.agentState = result;
  if (result.status === 'needsUserInput') {
    state.missingFields = result.clarificationJson;
    state.pendingFrontendAction = {
      type: 'request_required_fields',
      fields: result.clarificationJson
    };
    appendMessage(state, 'assistant', result.message);
    return;
  }

  state.missingFields = {};
  if (result.status === 'autoCreated') {
    state.planCards = [result.plan];
    state.selectedPlanCardId = result.plan.id;
    state.conflicts = [];
    state.toolResults = [
      result.calendarEventsToolResult,
      result.freeWindowsToolResult,
      result.scheduleToolResult,
      result.conflictCheckResult
    ].filter(Boolean);
    state.freeTimeSlots = [];
    state.pendingFrontendAction = null;
    appendMessage(state, 'assistant', result.message);
    return;
  }

  state.planCards = result.plans;
  state.selectedPlanCardId = result.plan?.id ?? null;
  state.conflicts = result.conflicts;
  state.toolResults = [
    result.calendarEventsToolResult,
    result.freeWindowsToolResult,
    result.scheduleToolResult,
    result.conflictCheckResult
  ].filter(Boolean);
  state.freeTimeSlots = [];
  state.pendingFrontendAction = result.plans.length > 0 ? { type: 'select_plan', runId: result.runId } : { type: 'need_user_choice', runId: result.runId };
  appendMessage(state, 'assistant', result.plans.length > 0 ? `已生成 ${result.plans.length} 个排期方案。` : '排期需要用户先选择处理方式。');
}

async function emitEvent(onEvent: AgentMainFlowEventHandler | undefined, event: AgentMainFlowEvent): Promise<void> {
  await onEvent?.(event);
}

function buildCompactionEvent(
  triggerType: 'manual' | 'auto' | 'micro',
  beforeTokens: number,
  afterTokens: number,
  llmUsage?: AgentCompactionEvent['llmUsage']
): AgentCompactionEvent {
  const savedTokens = Math.max(0, beforeTokens - afterTokens);
  return {
    triggerType,
    beforeTokens,
    afterTokens,
    savedTokens,
    savedRatio: beforeTokens > 0 ? savedTokens / beforeTokens : 0,
    thresholdTokens: triggerType === 'auto' ? 7500 : undefined,
    llmUsage
  };
}

export async function runAgentMainFlow({ userId, input, clarificationJson, onEvent }: RunMainFlowInput): Promise<AgentMainFlowResponse> {
  const command = parseCommand(input);

  if (command.command === 'clear') {
    clearSessionState(userId);
    await Promise.all([
      conversationRepository.clearConversationMessages(userId),
      jobRepository.cancelActiveAgentJobsByUser(userId),
      cancelPendingCheckpointsByUser(userId),
      clearPlanningSessionsByUser(userId)
    ]);
    const data: AgentCommandResponse = {
      runId: `command-${Date.now()}`,
      status: 'commandResult',
      command: 'clear',
      message: '已清空当前会话记忆和 Token 账。'
    };
    await emitEvent(onEvent, { type: 'commandResult', command: 'clear', message: data.message });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  const state = getSession(userId);
  const compressionSettings = getCompressionSettings(userId);
  const turnContextBefore = estimateSessionTokens(state);
  const microBeforeTokens = turnContextBefore;
  const microLastCompactedAt = state.lastCompactedAt;
  const preparedState = await maybeMicroCompactSession(userId, state);
  const microCompactEvent =
    preparedState.lastCompactedAt && preparedState.lastCompactedAt !== microLastCompactedAt
      ? buildCompactionEvent('micro', microBeforeTokens, estimateSessionTokens(preparedState), consumeLatestCompactionUsage(userId))
      : undefined;

  if (command.command === 'compact') {
    const manualBeforeTokens = estimateSessionTokens(preparedState);
    const { summary, llmUsage } = await compactSession(preparedState, 'manual', command.trailingText);
    const nextState = await rewriteSessionWithSummary(userId, preparedState, summary, 'manual', command.trailingText);
    const compactApplied = nextState !== preparedState;
    const compactEvent = compactApplied ? buildCompactionEvent('manual', manualBeforeTokens, estimateSessionTokens(nextState), llmUsage) : undefined;
    const data: AgentCommandResponse = {
      runId: `command-${Date.now()}`,
      status: 'commandResult',
      command: 'compact',
      message: !compactApplied
        ? '本次压缩未降低上下文，已保留原会话状态。'
        : command.trailingText
        ? '已压缩上下文，并保留了你补充的要求。'
        : '已压缩上下文，并保留有效排期信息。',
      summary
    };
    const metricResult = {
      ...data,
      llmUsageByStep: llmUsage ? { compaction: llmUsage } : undefined
    };
    recordAgentTurnTokenMetric(userId, {
      runId: data.runId,
      status: data.status,
      phase: 'manualCompact',
      compressionEnabled: compressionSettings.enabled,
      contextTokensBefore: turnContextBefore,
      state: nextState,
      result: metricResult,
      compactEvent
    });
    await emitEvent(onEvent, { type: 'commandResult', command: 'compact', message: data.message, summary });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  appendMessage(preparedState, 'user', input);
  const autoBeforeTokens = estimateSessionTokens(preparedState);
  const autoLastCompactedAt = preparedState.lastCompactedAt;
  const activeState = await maybeAutoCompactSession(userId, preparedState);
  const autoCompactEvent =
    activeState.lastCompactedAt && activeState.lastCompactedAt !== autoLastCompactedAt
      ? buildCompactionEvent('auto', autoBeforeTokens, estimateSessionTokens(activeState), consumeLatestCompactionUsage(userId))
      : undefined;
  const compactEvent = autoCompactEvent ?? microCompactEvent;
  // ==== LLM 意图识别（唯一的判断者）====
  // 一条输入可拆出多个操作（resume / new_task / 日程 CRUD / chat），
  // 是否"继续"、是否新任务、CRUD 参数全部由 LLM 语义判断，代码不写死关键词。
  const resumeQueue = await buildResumeQueueContext(userId);
  const inputForIntent = clarificationJson
    ? `${input}\n补充信息：${JSON.stringify(clarificationJson)}`
    : input;
  const classification = await classifyUserIntent(inputForIntent, {
    state: activeState,
    resume: resumeQueue,
    nowIso: nowIsoWithOffset(),
    timezone: 'Asia/Shanghai'
  });

  const hasBusinessOperation = classification.operations.some((op) => op.kind !== 'chat');

  // 纯聊天：没有任何业务操作，直接回答
  if (!hasBusinessOperation) {
    const answer =
      classification.operations.map((op) => op.answer).filter((text): text is string => Boolean(text)).join('\n') ||
      '这个问题不需要进入排期 Agent。你可以告诉我：要安排什么任务、要查改删哪条日程，或者"继续"上次的任务。';
    appendMessage(activeState, 'assistant', answer);
    const data: AgentLlmAnswerResponse = {
      runId: `llm-${Date.now()}`,
      status: 'llmAnswer',
      rawInput: input,
      answer,
      reason: classification.reason
    };
    recordAgentTurnTokenMetric(userId, {
      runId: data.runId,
      status: data.status,
      phase: 'directAnswer',
      compressionEnabled: compressionSettings.enabled,
      contextTokensBefore: turnContextBefore,
      state: activeState,
      result: data,
      compactEvent
    });
    await emitEvent(onEvent, { type: 'directAnswer', answer, reason: classification.reason });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  // ==== 顺序执行操作（resume 优先、逐条落库、每个操作独立成败）====
  const execution = await executeIntentOperations({
    userId,
    rawInput: input,
    classification,
    clarificationJson,
    onEvent
  });
  const primary = execution.primary;

  if (primary) {
    // new_task / resume 产生了 Agent 业务响应：合并进会话状态（方案卡、待确认等）
    mergeAgentResultIntoState(activeState, input, primary);
    if (execution.report.trim()) {
      appendMessage(activeState, 'assistant', execution.report);
    }
    const finalResponse = { ...primary, operationsReport: execution.report || undefined };
    recordAgentTurnTokenMetric(userId, {
      runId: (primary as { runId?: string }).runId ?? `ops-${Date.now()}`,
      status: primary.status,
      phase: 'scheduleAgent',
      compressionEnabled: compressionSettings.enabled,
      contextTokensBefore: turnContextBefore,
      state: activeState,
      result: finalResponse,
      compactEvent
    });
    await emitEvent(onEvent, { type: 'final', data: finalResponse });
    return finalResponse;
  }

  // 挂起分支（歧义/冲突）之外的其他操作结果：不能静默丢掉，拼在提问前一起汇报
  const otherResultsReport = execution.results
    .filter((result) => result.status !== 'needsUserInput' && result.status !== 'needsSelection' && result.status !== 'needsConflictResolution' && result.message)
    .map((result) => result.message)
    .join('\n');

  // 增/改日程字段不足：返回与复杂排期一致的 needsUserInput，复用前端澄清面板
  if (execution.pendingClarification) {
    const pending = execution.pendingClarification;
    const answer = otherResultsReport ? `${otherResultsReport}\n${pending.message}` : pending.message;
    appendMessage(activeState, 'assistant', answer);
    const data: AgentClarificationResponse = {
      runId: `clarify-${Date.now()}`,
      status: 'needsUserInput',
      rawInput: input,
      message: pending.message,
      reasons: pending.reasons,
      clarificationJson: pending.clarificationJson
    };
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  // 有歧义操作（日程定位到多条候选）：返回结构化选项，由前端弹框让用户选
  if (execution.pendingSelection) {
    const pending = execution.pendingSelection;
    const question = `${pending.message}：${pending.options
      .map((option, index) => `${index + 1}. 「${option.title}」${option.timeText}`)
      .join('；')}`;
    const answer = otherResultsReport ? `${otherResultsReport}\n${question}` : question;
    appendMessage(activeState, 'assistant', answer);
    const data: AgentEventSelectionResponse = {
      runId: `sel-${Date.now()}`,
      status: 'needsSelection',
      rawInput: input,
      message: pending.message,
      options: pending.options,
      pendingOperation: pending.pendingOperation as AgentEventSelectionResponse['pendingOperation'],
      reason: classification.reason
    };
    await emitEvent(onEvent, { type: 'directAnswer', answer, reason: classification.reason });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  // 有冲突挂起操作：返回决策卡数据，由前端用主 agent 的冲突决策卡样式让用户选
  if (execution.pendingConflict) {
    const pending = execution.pendingConflict;
    const conflictLines = pending.conflicts
      .map((conflict, index) => `${index + 1}. 「${conflict.title}」${conflict.timeText}`)
      .join('；');
    const question = `${pending.message}：${conflictLines}。可以保留冲突、把原有日程后移 ${pending.suggestedShiftMinutes} 分钟，或取消。`;
    const answer = otherResultsReport ? `${otherResultsReport}\n${question}` : question;
    appendMessage(activeState, 'assistant', answer);
    const data: AgentConflictResolutionResponse = {
      runId: `conflict-${Date.now()}`,
      status: 'needsConflictResolution',
      rawInput: input,
      message: pending.message,
      conflicts: pending.conflicts,
      suggestedShiftMinutes: pending.suggestedShiftMinutes,
      pendingOperation: pending.pendingOperation as AgentConflictResolutionResponse['pendingOperation'],
      reason: classification.reason
    };
    await emitEvent(onEvent, { type: 'directAnswer', answer, reason: classification.reason });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  // 只有 CRUD / 恢复提示类操作：把每个操作的结果聚合成一条回复
  const answer = execution.report.trim() || '操作已处理。';
  appendMessage(activeState, 'assistant', answer);
  const data: AgentLlmAnswerResponse = {
    runId: `ops-${Date.now()}`,
    status: 'llmAnswer',
    rawInput: input,
    answer,
    reason: classification.reason
  };
  recordAgentTurnTokenMetric(userId, {
    runId: data.runId,
    status: data.status,
    phase: 'operationsExecuted',
    compressionEnabled: compressionSettings.enabled,
    contextTokensBefore: turnContextBefore,
    state: activeState,
    result: data,
    compactEvent
  });
  await emitEvent(onEvent, { type: 'directAnswer', answer, reason: classification.reason });
  await emitEvent(onEvent, { type: 'final', data });
  return data;
}

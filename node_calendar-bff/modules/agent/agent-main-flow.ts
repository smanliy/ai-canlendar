import { runScheduleAgent } from './agent.orchestrator';
import type { AgentAutoCreatedResponse, AgentClarificationResponse, AgentCreateRunResponse, AgentRunResponse } from './agent.types';
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
import * as conversationRepository from './agent-conversation.repository';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

type SessionCommand = 'clear' | 'compact';

interface ParsedCommand {
  command: SessionCommand | null;
  trailingText: string;
}

interface RouteResult {
  needAgent: boolean;
  reason: string;
  directAnswer?: string;
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

function getDeepSeekApiKey(): string {
  return process.env.DEEPSEEK_API_KEY?.trim() || '';
}

function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash';
}

function parseJsonObject(content: string): Record<string, unknown> {
  const text = content.trim();
  if (!text) throw new Error('LLM returned blank content');
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`LLM returned non-JSON content: ${text.slice(0, 300)}`);
    const value = JSON.parse(match[0]);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }
}

async function callDeepSeekJson(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, maxTokens = 1600): Promise<Record<string, unknown>> {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY');
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: getDeepSeekModel(),
      messages,
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      thinking: { type: 'disabled' }
    })
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek main-flow request failed: HTTP ${response.status} ${rawText}`);
  }
  const data = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = data.choices?.[0]?.message?.content || '';
  return parseJsonObject(content);
}

function likelyNeedsSchedulingAgent(input: string): boolean {
  const text = input.toLowerCase();
  return [
    '排期',
    '日程',
    '安排',
    '计划',
    '截止',
    'deadline',
    '花费',
    '耗时',
    '小时',
    '分钟',
    '修改方案',
    '确认方案',
    '写入日历',
    '冲突',
    '黄金时间',
    '选中',
    '批注',
    'diy'
  ].some((keyword) => text.includes(keyword));
}

function buildSimpleDirectRoute(input: string): RouteResult | null {
  const normalized = input.trim().toLowerCase().replace(/[！!。.\s]/g, '');
  const greetings = new Set([
    '你好',
    '您好',
    'hello',
    'hi',
    'hey',
    '在吗',
    '在不在',
    '嗨',
    '哈喽'
  ]);

  if (greetings.has(normalized)) {
    return {
      needAgent: false,
      reason: '用户只是寒暄，不需要进入日程排期 Agent',
      directAnswer: '你好，我在。你可以告诉我目标、截止时间和预计花费时间，我再帮你生成排期方案。'
    };
  }

  if (['谢谢', '感谢', 'thanks', 'thankyou'].includes(normalized)) {
    return {
      needAgent: false,
      reason: '用户只是表达感谢，不需要进入日程排期 Agent',
      directAnswer: '不客气。需要继续排期或调整方案时，直接告诉我就行。'
    };
  }

  return null;
}

function buildLocalRoute(input: string): RouteResult {
  const directRoute = buildSimpleDirectRoute(input);
  if (directRoute) return directRoute;

  if (likelyNeedsSchedulingAgent(input)) {
    return {
      needAgent: true,
      reason: '命中日程排期、任务安排、方案修改或写入日历相关意图'
    };
  }
  return {
    needAgent: false,
    reason: '未命中排期意图，按普通问答直接回答',
    directAnswer: '我可以直接回答这个问题；如果你要我安排日程，请补充截止时间和预计花费时间。'
  };
}

async function routeUserInput(input: string, state: SchedulingSessionState): Promise<RouteResult> {
  const directRoute = buildSimpleDirectRoute(input);
  if (directRoute) return directRoute;

  if (!getDeepSeekApiKey()) return buildLocalRoute(input);

  try {
    const result = await callDeepSeekJson(
      [
        {
          role: 'system',
          content: [
            '你是单会话日程排期 Agent 的请求路由器。',
            '只返回 JSON object，不要 markdown。',
            'Schema: {"needAgent": boolean, "reason": string, "answer": string | null}',
            '规则：',
            '0. 如果用户只是说“你好”、“hello”、“hi”、“在吗”、感谢、寒暄，needAgent=false，并直接友好回复。',
            '1. 如果用户在询问你是谁、你能做什么、能力介绍、使用说明、普通知识问答、解释、闲聊，且没有明确要求创建/修改/安排日程，needAgent=false，并在 answer 里直接回答。',
            '2. 只有当用户明确要创建、修改、安排、优化、确认、写入日程，或需要使用本地日历/空闲时间/冲突检测/方案卡/批注/DIY 排期能力时，needAgent=true。',
            '3. 提到时间不一定需要 Agent；只有用户要你做排期动作或日程操作时才 needAgent=true。',
            '4. 不要在路由阶段拆分任务；needAgent=true 时后续已有 Agent 会处理。',
            '5. 如果用户询问当前模型、供应商、底层能力，只能基于 user message 里的 runtimeContext 回答；不知道的字段就说“不确定”，不要自行声称是 OpenAI/GPT。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            input,
            runtimeContext: {
              assistantName: 'ChronoAgent',
              llmProvider: 'DeepSeek',
              llmModel: getDeepSeekModel()
            },
            summary: state.summary,
            recentMessages: state.messages.slice(-8)
          })
        }
      ],
      1800
    );
    return {
      needAgent: Boolean(result.needAgent),
      reason: typeof result.reason === 'string' ? result.reason : 'LLM router returned a decision',
      directAnswer: typeof result.answer === 'string' ? result.answer : undefined
    };
  } catch (error) {
    console.warn('[Agent Main Flow] LLM router failed, using local heuristic:', error instanceof Error ? error.message : error);
    return buildLocalRoute(input);
  }
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
    await conversationRepository.clearConversationMessages(userId);
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
  const route = await routeUserInput(input, activeState);

  if (!route.needAgent) {
    const answer = route.directAnswer || '这个问题不需要进入排期 Agent。';
    appendMessage(activeState, 'assistant', answer);
    const data: AgentLlmAnswerResponse = {
      runId: `llm-${Date.now()}`,
      status: 'llmAnswer',
      rawInput: input,
      answer,
      reason: route.reason
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
    await emitEvent(onEvent, { type: 'directAnswer', answer, reason: route.reason });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  const result = await runScheduleAgent({ userId, input, clarificationJson, onEvent });
  mergeAgentResultIntoState(activeState, input, result);
  recordAgentTurnTokenMetric(userId, {
    runId: result.runId,
    status: result.status,
    phase: 'scheduleAgent',
    compressionEnabled: compressionSettings.enabled,
    contextTokensBefore: turnContextBefore,
    state: activeState,
    result,
    compactEvent
  });
  await emitEvent(onEvent, { type: 'final', data: result });
  return result;
}

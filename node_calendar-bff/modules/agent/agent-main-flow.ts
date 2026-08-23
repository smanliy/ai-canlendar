import { runScheduleAgent } from './agent.orchestrator';
import type { AgentClarificationResponse, AgentCreateRunResponse, AgentRunResponse, SchedulePlanOption } from './agent.types';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

type MessageRole = 'system' | 'user' | 'assistant';

interface MainFlowMessage {
  role: MessageRole;
  content: string;
  createdAt: string;
}

interface SchedulingSessionState {
  messages: MainFlowMessage[];
  summary: string | null;
  currentRequest: string | null;
  extractedFields: Record<string, unknown>;
  missingFields: Record<string, unknown>;
  toolResults: unknown[];
  freeTimeSlots: unknown[];
  planCards: SchedulePlanOption[];
  selectedPlanCardId: string | null;
  userAnnotations: unknown[];
  userConflictApprovals: unknown[];
  conflicts: unknown[];
  warnings: unknown[];
  agentState: unknown | null;
  pendingFrontendAction: unknown | null;
  lastCompactedAt: string | null;
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
  | { type: 'commandResult'; command: 'clear' | 'compat'; message: string; summary?: string }
  | { type: 'final'; data: AgentMainFlowResponse };

export type AgentMainFlowEventHandler = (event: AgentMainFlowEvent) => void | Promise<void>;

export interface AgentCommandResponse {
  runId: string;
  status: 'commandResult';
  command: 'clear' | 'compat';
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

const sessions = new Map<string, SchedulingSessionState>();

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptySession(): SchedulingSessionState {
  return {
    messages: [],
    summary: null,
    currentRequest: null,
    extractedFields: {},
    missingFields: {},
    toolResults: [],
    freeTimeSlots: [],
    planCards: [],
    selectedPlanCardId: null,
    userAnnotations: [],
    userConflictApprovals: [],
    conflicts: [],
    warnings: [],
    agentState: null,
    pendingFrontendAction: null,
    lastCompactedAt: null
  };
}

function getSession(userId: string): SchedulingSessionState {
  const existing = sessions.get(userId);
  if (existing) return existing;
  const next = createEmptySession();
  sessions.set(userId, next);
  return next;
}

function replaceSession(userId: string, state: SchedulingSessionState): SchedulingSessionState {
  sessions.set(userId, state);
  return state;
}

function appendMessage(state: SchedulingSessionState, role: MessageRole, content: string): void {
  state.messages.push({ role, content, createdAt: nowIso() });
}

function parseCommand(input: string): 'clear' | 'compat' | null {
  const command = input.trim().toLowerCase();
  if (command === '/clear') return 'clear';
  if (command === '/compat') return 'compat';
  return null;
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

function buildLocalCompactSummary(state: SchedulingSessionState): string {
  return [
    state.summary ? `Previous summary: ${state.summary}` : '',
    state.currentRequest ? `Current request: ${state.currentRequest}` : '',
    Object.keys(state.extractedFields).length ? `Extracted fields: ${JSON.stringify(state.extractedFields)}` : '',
    state.planCards.length ? `Plan cards: ${state.planCards.map((plan) => `${plan.name}:${plan.taskName}`).join(', ')}` : '',
    state.conflicts.length ? `Conflicts: ${JSON.stringify(state.conflicts)}` : '',
    state.pendingFrontendAction ? `Pending frontend action: ${JSON.stringify(state.pendingFrontendAction)}` : '',
    `Recent messages: ${state.messages.slice(-6).map((message) => `${message.role}: ${message.content}`).join('\n')}`
  ]
    .filter(Boolean)
    .join('\n');
}

async function compactSession(state: SchedulingSessionState): Promise<string> {
  if (!getDeepSeekApiKey()) return buildLocalCompactSummary(state);

  try {
    const result = await callDeepSeekJson(
      [
        {
          role: 'system',
          content: [
            '你是日程排期 Agent 的上下文压缩器。',
            '只返回 JSON object：{"summary": "压缩后的记忆"}。',
            '保留：当前目标、截止时间、预计花费时间、偏好、缺失字段、方案卡、用户选择、批注、冲突允许记录、待办下一步。',
            '删除：重复对话、过时中间推理、已摘要的原始日志。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify(state)
        }
      ],
      2200
    );
    return typeof result.summary === 'string' && result.summary.trim() ? result.summary.trim() : buildLocalCompactSummary(state);
  } catch (error) {
    console.warn('[Agent Main Flow] LLM compaction failed, using local summary:', error instanceof Error ? error.message : error);
    return buildLocalCompactSummary(state);
  }
}

function mergeAgentResultIntoState(state: SchedulingSessionState, input: string, result: AgentRunResponse | AgentClarificationResponse): void {
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

export async function runAgentMainFlow({ userId, input, clarificationJson, onEvent }: RunMainFlowInput): Promise<AgentMainFlowResponse> {
  const command = parseCommand(input);

  if (command === 'clear') {
    replaceSession(userId, createEmptySession());
    const data: AgentCommandResponse = {
      runId: `command-${Date.now()}`,
      status: 'commandResult',
      command: 'clear',
      message: '已清空当前会话记忆。'
    };
    await emitEvent(onEvent, { type: 'commandResult', command: 'clear', message: data.message });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  const state = getSession(userId);

  if (command === 'compat') {
    const summary = await compactSession(state);
    const compacted = {
      ...state,
      messages: [{ role: 'system' as const, content: `Compressed scheduling memory:\n${summary}`, createdAt: nowIso() }],
      summary,
      lastCompactedAt: nowIso()
    };
    replaceSession(userId, compacted);
    const data: AgentCommandResponse = {
      runId: `command-${Date.now()}`,
      status: 'commandResult',
      command: 'compat',
      message: '已压缩上下文，并保留有效排期信息。',
      summary
    };
    await emitEvent(onEvent, { type: 'commandResult', command: 'compat', message: data.message, summary });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  appendMessage(state, 'user', input);
  const route = await routeUserInput(input, state);

  if (!route.needAgent) {
    const answer = route.directAnswer || '这个问题不需要进入排期 Agent。';
    appendMessage(state, 'assistant', answer);
    const data: AgentLlmAnswerResponse = {
      runId: `llm-${Date.now()}`,
      status: 'llmAnswer',
      rawInput: input,
      answer,
      reason: route.reason
    };
    await emitEvent(onEvent, { type: 'directAnswer', answer, reason: route.reason });
    await emitEvent(onEvent, { type: 'final', data });
    return data;
  }

  const result = await runScheduleAgent({ userId, input, clarificationJson, onEvent });
  mergeAgentResultIntoState(state, input, result);
  await emitEvent(onEvent, { type: 'final', data: result });
  return result;
}

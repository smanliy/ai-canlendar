import type { SchedulePlanOption, TokenUsageSummary } from "./agent.types";

type MessageRole = "system" | "user" | "assistant";
type CompactionMode = "manual" | "auto" | "micro";

export interface AgentCompressionSettings {
  enabled: boolean;
}

export interface AgentCompactionEvent {
  triggerType: CompactionMode;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedRatio: number;
  thresholdTokens?: number;
  llmUsage?: TokenUsageSummary;
}

export interface AgentNodeTokenMetric {
  nodeId: string;
  name: string;
  estimatedPromptTokens: number;
  actualPromptTokens: number;
  actualCompletionTokens: number;
  actualTotalTokens: number;
  model?: string;
}

export interface AgentTurnTokenMetric {
  turnId: number;
  runId: string;
  status: string;
  phase: string;
  compressionEnabled: boolean;
  contextTokensBefore: number;
  contextTokensAfter: number;
  baselineContextTokens: number;
  compressedContextTokens: number;
  savedTokens: number;
  savedRatio: number;
  totalLlmTokens: number;
  compactEvent?: AgentCompactionEvent;
  nodes: AgentNodeTokenMetric[];
  createdAt: string;
}

export interface AgentTokenMetricsSnapshot {
  settings: AgentCompressionSettings;
  samples: AgentTurnTokenMetric[];
  summary: {
    turnCount: number;
    baselineContextTokens: number;
    compressedContextTokens: number;
    savedTokens: number;
    savedRatio: number;
    totalLlmTokens: number;
    compressionEvents: number;
  };
}

interface ToolResultPlaceholder {
  kind: "tool_result_placeholder";
  status: "cleared";
  mode: CompactionMode;
  clearedCount: number;
  retainedCount: number;
  clearedToolNames: string[];
  clearedAt: string;
  note: string;
}

export interface MainFlowMessage {
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface SchedulingSessionState {
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
  lastActivityAt: string | null;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const AUTO_COMPACT_WARN_TOKENS = 6000;
const AUTO_COMPACT_TRIGGER_TOKENS = 7500;
const AUTO_COMPACT_HARD_LIMIT_TOKENS = 9000;
const AUTO_COMPACT_COOLDOWN_MS = 90_000;
const MICRO_COMPACT_IDLE_MS = 60 * 60 * 1000;
const MICRO_COMPACT_KEEP_MESSAGES = 5;

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
    lastCompactedAt: null,
    lastActivityAt: null,
  };
}
// 一个人一个会话仓库
const sessions = new Map<string, SchedulingSessionState>();
const compressionSettingsByUser = new Map<string, AgentCompressionSettings>();
interface TokenRoundState {
  runId: string | null;
  samples: AgentTurnTokenMetric[];
  baselineContextTokens: number;
  turnCounter: number;
}

const tokenMetricsByUser = new Map<string, TokenRoundState>();
const latestCompactionUsageByUser = new Map<string, TokenUsageSummary>();

function getTokenRoundState(userId: string): TokenRoundState {
  const existing = tokenMetricsByUser.get(userId);
  if (existing) return existing;
  const next: TokenRoundState = {
    runId: null,
    samples: [],
    baselineContextTokens: 0,
    turnCounter: 0,
  };
  tokenMetricsByUser.set(userId, next);
  return next;
}

function resetTokenRoundState(userId: string, runId: string): TokenRoundState {
  const next: TokenRoundState = {
    runId,
    samples: [],
    baselineContextTokens: 0,
    turnCounter: 0,
  };
  tokenMetricsByUser.set(userId, next);
  return next;
}

function trimText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compactJsonValue(value: unknown, maxLength: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return trimText(value, maxLength);
  if (typeof value !== "object") return value;
  try {
    const text = JSON.stringify(value);
    return text.length <= maxLength ? value : { compacted: true, preview: `${text.slice(0, maxLength)}...` };
  } catch {
    return trimText(String(value), maxLength);
  }
}

function compactArrayItems(value: unknown[], maxItemLength: number, maxItems: number): unknown[] {
  return value.slice(-maxItems).map((item) => compactJsonValue(item, maxItemLength));
}

function slimPlanCard(plan: SchedulePlanOption): SchedulePlanOption {
  return {
    id: plan.id,
    name: trimText(plan.name, 120) ?? plan.name,
    type: plan.type,
    color: plan.color,
    accent: plan.accent,
    taskName: trimText(plan.taskName, 160) ?? plan.taskName,
    deadline: plan.deadline,
    totalHours: plan.totalHours,
    summary: trimText(plan.summary, 260),
    reason: trimText(plan.reason, 260),
    warnings: plan.warnings?.slice(0, 5).map((warning) => ({
      type: warning.type,
      message: trimText(warning.message, 180) ?? warning.message,
    })),
    items: plan.items.slice(0, 24).map((item) => ({
      id: item.id,
      title: trimText(item.title, 160) ?? item.title,
      date: item.date,
      timeRange: item.timeRange,
      startAt: item.startAt,
      endAt: item.endAt,
      durationHours: item.durationHours,
      category: item.category,
      priority: item.priority,
    })),
  };
}

function slimAgentState(value: unknown): unknown {
  const state = readObject(value);
  if (!Object.keys(state).length) return null;
  return {
    runId: typeof state.runId === "string" ? state.runId : undefined,
    status: typeof state.status === "string" ? state.status : undefined,
    rawInput: trimText(state.rawInput, 300),
    message: trimText(state.message, 300),
    reasons: Array.isArray(state.reasons) ? state.reasons.slice(0, 6).map((reason) => trimText(reason, 160)).filter(Boolean) : undefined,
    selectedPlanId: typeof state.selectedPlanId === "string" ? state.selectedPlanId : undefined,
    planId: readObject(state.plan).id,
    splitResult: compactJsonValue(state.splitResult, 900),
    annotation: compactJsonValue(state.annotation, 900),
  };
}

function buildContextProjection(state: SchedulingSessionState): Record<string, unknown> {
  const hasCompressedSystemMessage = state.messages.some(
    (message) => message.role === "system" && message.content.startsWith("Compressed scheduling memory")
  );
  return {
    summary: hasCompressedSystemMessage ? "" : state.summary ?? "",
    currentRequest: state.currentRequest ?? "",
    extractedFields: state.extractedFields,
    missingFields: state.missingFields,
    pendingFrontendAction: compactJsonValue(state.pendingFrontendAction, 900),
    selectedPlanCardId: state.selectedPlanCardId,
    planCards: state.planCards.map(slimPlanCard),
    conflicts: compactArrayItems(state.conflicts, 500, 12),
    warnings: compactArrayItems(state.warnings, 400, 12),
    toolResults: compactToolResults(state.toolResults, state.lastCompactedAt ? 0 : 4, state.lastCompactedAt ? "auto" : "micro"),
    agentState: state.lastCompactedAt ? slimAgentState(state.agentState) : compactJsonValue(state.agentState, 2400),
    messages: state.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
}

function replaceSession(
  userId: string,
  state: SchedulingSessionState,
): SchedulingSessionState {
  sessions.set(userId, state);
  return state;
}
// 获取会话 没有创空
export function getSession(userId: string): SchedulingSessionState {
  const existing = sessions.get(userId);
  if (existing) return existing;
  const next = createEmptySession();
  sessions.set(userId, next);
  return next;
}
// 追加新的聊天记录，刷新会话最新活跃时间
export function appendMessage(
  state: SchedulingSessionState,
  role: MessageRole,
  content: string,
): void {
  state.messages.push({ role, content, createdAt: nowIso() });
  state.lastActivityAt = nowIso();
}
// 估算token函数
function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 2.8));
}

export function estimatePayloadTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateTokens(value);
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return estimateTokens(String(value));
  }
}

export function estimateSessionTokens(state: SchedulingSessionState): number {
  return estimatePayloadTokens(buildContextProjection(state));
}

export function getCompressionSettings(userId: string): AgentCompressionSettings {
  const existing = compressionSettingsByUser.get(userId);
  if (existing) return existing;
  const defaults = { enabled: true };
  compressionSettingsByUser.set(userId, defaults);
  return defaults;
}

export function setCompressionSettings(userId: string, settings: Partial<AgentCompressionSettings>): AgentCompressionSettings {
  const next = {
    ...getCompressionSettings(userId),
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : getCompressionSettings(userId).enabled,
  };
  compressionSettingsByUser.set(userId, next);
  return next;
}

function readUsage(value: unknown): { promptTokens: number; completionTokens: number; totalTokens: number; model?: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const promptTokens = Number(record.promptTokens);
  const completionTokens = Number(record.completionTokens);
  const totalTokens = Number(record.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    model: typeof record.model === "string" ? record.model : undefined,
  };
}

function readDeepSeekTokenUsage(
  data: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } },
  model: string,
): TokenUsageSummary | null {
  const promptTokens = Number(data.usage?.prompt_tokens);
  const completionTokens = Number(data.usage?.completion_tokens);
  const totalTokens = Number(data.usage?.total_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    model,
  };
}

function buildNodeMetrics(llmUsageByStep: unknown, compactEvent?: AgentCompactionEvent): AgentNodeTokenMetric[] {
  const nodes: AgentNodeTokenMetric[] = [];
  const stepNames: Record<string, string> = {
    "step-1": "解析用户输入",
    "step-2": "判断是否拆分",
    router: "请求路由",
    compaction: "压缩摘要",
  };

  if (compactEvent?.llmUsage) {
    nodes.push({
      nodeId: `compaction-${compactEvent.triggerType}`,
      name: compactEvent.triggerType === "manual" ? "手动压缩摘要" : compactEvent.triggerType === "micro" ? "空闲压缩摘要" : "阈值压缩摘要",
      estimatedPromptTokens: compactEvent.llmUsage.promptTokens,
      actualPromptTokens: compactEvent.llmUsage.promptTokens,
      actualCompletionTokens: compactEvent.llmUsage.completionTokens,
      actualTotalTokens: compactEvent.llmUsage.totalTokens,
      model: compactEvent.llmUsage.model,
    });
  }

  if (!llmUsageByStep || typeof llmUsageByStep !== "object") return nodes;
  Object.entries(llmUsageByStep as Record<string, unknown>).forEach(([nodeId, usageValue]) => {
    const usage = readUsage(usageValue);
    if (!usage) return;
    nodes.push({
        nodeId,
        name: stepNames[nodeId] ?? nodeId,
        estimatedPromptTokens: usage.promptTokens,
        actualPromptTokens: usage.promptTokens,
        actualCompletionTokens: usage.completionTokens,
        actualTotalTokens: usage.totalTokens,
        model: usage.model,
    });
  });
  return nodes;
}

export function recordAgentTurnTokenMetric(
  userId: string,
  input: {
    runId: string;
    status: string;
    phase: string;
    compressionEnabled: boolean;
    contextTokensBefore: number;
    state: SchedulingSessionState;
    result?: unknown;
    compactEvent?: AgentCompactionEvent;
  },
): AgentTurnTokenMetric {
  const roundState = getTokenRoundState(userId);
  const activeState = roundState.runId === input.runId ? roundState : resetTokenRoundState(userId, input.runId);
  const compressedContextTokens = estimateSessionTokens(input.state);
  const previousBaseline = activeState.baselineContextTokens ?? input.contextTokensBefore;
  const observedContextGrowth = Math.max(0, compressedContextTokens - input.contextTokensBefore);
  const addedContextTokens = Math.max(
    observedContextGrowth,
    estimatePayloadTokens(input.result) + estimatePayloadTokens(input.state.currentRequest)
  );
  const estimatedBaselineContextTokens = input.compactEvent
    ? Math.max(previousBaseline + addedContextTokens, input.compactEvent.beforeTokens, input.contextTokensBefore)
    : Math.max(previousBaseline + addedContextTokens, input.contextTokensBefore);
  const baselineContextTokens = Math.max(previousBaseline, estimatedBaselineContextTokens, compressedContextTokens);
  if (compressedContextTokens > estimatedBaselineContextTokens) {
    console.warn("[TokenMetrics] compressed context exceeded baseline estimate; clamped baseline", {
      userId,
      runId: input.runId,
      phase: input.phase,
      estimatedBaselineContextTokens,
      compressedContextTokens,
    });
  }
  const savedTokens = Math.max(0, baselineContextTokens - compressedContextTokens);
  const nodes = buildNodeMetrics(input.result && typeof input.result === "object" ? (input.result as { llmUsageByStep?: unknown }).llmUsageByStep : undefined, input.compactEvent);
  const turnId = activeState.turnCounter + 1;
  const sample: AgentTurnTokenMetric = {
    turnId,
    runId: input.runId,
    status: input.status,
    phase: input.phase,
    compressionEnabled: input.compressionEnabled,
    contextTokensBefore: input.contextTokensBefore,
    contextTokensAfter: compressedContextTokens,
    baselineContextTokens,
    compressedContextTokens,
    savedTokens,
    savedRatio: baselineContextTokens > 0 ? savedTokens / baselineContextTokens : 0,
    totalLlmTokens: nodes.reduce((total, node) => total + node.actualTotalTokens, 0),
    compactEvent: input.compactEvent,
    nodes,
    createdAt: nowIso(),
  };
  activeState.runId = input.runId;
  activeState.baselineContextTokens = baselineContextTokens;
  activeState.turnCounter = turnId;
  activeState.samples.push(sample);
  activeState.samples = activeState.samples.slice(-120);
  tokenMetricsByUser.set(userId, activeState);
  return sample;
}

export function recordAgentTurnContinuationTokenMetric(
  userId: string,
  input: {
    runId: string;
    status: string;
    phase: string;
    compressionEnabled: boolean;
    contextTokensBefore: number;
    state: SchedulingSessionState;
    result?: unknown;
    compactEvent?: AgentCompactionEvent;
  },
): AgentTurnTokenMetric {
  const roundState = getTokenRoundState(userId);
  if (roundState.runId !== input.runId || roundState.samples.length === 0) {
    return recordAgentTurnTokenMetric(userId, input);
  }

  const latest = roundState.samples[roundState.samples.length - 1];

  const compressedContextTokens = estimateSessionTokens(input.state);
  const previousBaseline = roundState.baselineContextTokens ?? latest.baselineContextTokens;
  const observedContextGrowth = Math.max(0, compressedContextTokens - latest.compressedContextTokens);
  const addedContextTokens = Math.max(
    observedContextGrowth,
    estimatePayloadTokens(input.result) + estimatePayloadTokens(input.state.currentRequest)
  );
  const estimatedBaselineContextTokens = input.compactEvent
    ? Math.max(previousBaseline + addedContextTokens, input.compactEvent.beforeTokens, input.contextTokensBefore)
    : Math.max(previousBaseline + addedContextTokens, input.contextTokensBefore);
  const baselineContextTokens = Math.max(previousBaseline, estimatedBaselineContextTokens, compressedContextTokens);
  if (compressedContextTokens > estimatedBaselineContextTokens) {
    console.warn("[TokenMetrics] continuation compressed context exceeded baseline estimate; clamped baseline", {
      userId,
      runId: input.runId,
      phase: input.phase,
      estimatedBaselineContextTokens,
      compressedContextTokens,
    });
  }

  const nextNodes = buildNodeMetrics(input.result && typeof input.result === "object" ? (input.result as { llmUsageByStep?: unknown }).llmUsageByStep : undefined, input.compactEvent);
  const savedTokens = Math.max(0, baselineContextTokens - compressedContextTokens);
  const updated: AgentTurnTokenMetric = {
    ...latest,
    status: input.status,
    phase: latest.phase.includes(input.phase) ? latest.phase : `${latest.phase}+${input.phase}`,
    compressionEnabled: input.compressionEnabled,
    contextTokensAfter: compressedContextTokens,
    baselineContextTokens,
    compressedContextTokens,
    savedTokens,
    savedRatio: baselineContextTokens > 0 ? savedTokens / baselineContextTokens : 0,
    totalLlmTokens: latest.totalLlmTokens + nextNodes.reduce((total, node) => total + node.actualTotalTokens, 0),
    compactEvent: input.compactEvent ?? latest.compactEvent,
    nodes: [...latest.nodes, ...nextNodes],
    createdAt: nowIso(),
  };

  roundState.runId = input.runId;
  roundState.baselineContextTokens = baselineContextTokens;
  roundState.samples[roundState.samples.length - 1] = updated;
  tokenMetricsByUser.set(userId, roundState);
  return updated;
}

export function getAgentTokenMetrics(userId: string): AgentTokenMetricsSnapshot {
  const samples = getTokenRoundState(userId).samples;
  const latest = samples[samples.length - 1];
  const baselineContextTokens = latest?.baselineContextTokens ?? 0;
  const savedTokens = latest?.savedTokens ?? 0;
  return {
    settings: getCompressionSettings(userId),
    samples,
    summary: {
      turnCount: samples.length,
      baselineContextTokens,
      compressedContextTokens: latest?.compressedContextTokens ?? 0,
      savedTokens,
      savedRatio: baselineContextTokens > 0 ? savedTokens / baselineContextTokens : 0,
      totalLlmTokens: samples.reduce((total, sample) => total + sample.totalLlmTokens, 0),
      compressionEvents: samples.filter((sample) => Boolean(sample.compactEvent)).length,
    },
  };
}

export function consumeLatestCompactionUsage(userId: string): TokenUsageSummary | undefined {
  const usage = latestCompactionUsageByUser.get(userId);
  latestCompactionUsageByUser.delete(userId);
  return usage;
}

export function clearSessionState(userId: string): SchedulingSessionState {
  const next = createEmptySession();
  sessions.set(userId, next);
  tokenMetricsByUser.delete(userId);
  latestCompactionUsageByUser.delete(userId);
  return next;
}
//文本截断工具
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function isToolResultPlaceholder(value: unknown): value is ToolResultPlaceholder {
  return Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "tool_result_placeholder";
}

function readToolResultName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const toolName =
    typeof record.tool === "string"
      ? record.tool
      : typeof record.name === "string"
        ? record.name
        : typeof record.toolName === "string"
          ? record.toolName
          : typeof record.type === "string"
            ? record.type
            : "";
  return toolName.trim();
}

function buildToolResultPlaceholder(removedToolResults: unknown[], mode: CompactionMode, retainedCount: number): ToolResultPlaceholder {
  const clearedToolNames = Array.from(
    new Set(
      removedToolResults
        .map((item) => readToolResultName(item))
        .filter(Boolean)
    )
  ).slice(0, 6);

  return {
    kind: "tool_result_placeholder",
    status: "cleared",
    mode,
    clearedCount: removedToolResults.length,
    retainedCount,
    clearedToolNames,
    clearedAt: nowIso(),
    note: `tools cleared: ${removedToolResults.length} older tool results compacted`
  };
}

function compactToolResults(toolResults: unknown[], keepRecentCount: number, mode: CompactionMode): unknown[] {
  const entries = Array.isArray(toolResults) ? toolResults.filter(Boolean) : [];
  const placeholders = entries.filter(isToolResultPlaceholder);
  const actualResults = entries.filter((item) => !isToolResultPlaceholder(item));

  if (keepRecentCount <= 0) {
    if (actualResults.length === 0) return placeholders;
    return [...placeholders, buildToolResultPlaceholder(actualResults, mode, 0)];
  }

  if (actualResults.length <= keepRecentCount) {
    return [...placeholders, ...actualResults];
  }

  const retainedActualResults = actualResults.slice(-keepRecentCount);
  const removedActualResults = actualResults.slice(0, -keepRecentCount);
  const placeholder = buildToolResultPlaceholder(removedActualResults, mode, retainedActualResults.length);

  return [...placeholders, placeholder, ...retainedActualResults];
}
//准备发给deepseek-摘要生成器的快照,产生精简快照
//根据压缩模式，裁剪会话最近消息与工具结果，生成一份精简快照提交给大模型，用于生成会话上下文摘要；同时对单条超长消息进行字符截断，防止单条内容体积过大。
function buildCompactionSnapshot(
  state: SchedulingSessionState,
  mode: CompactionMode,
  extraInstruction = "",
): Record<string, unknown> {
  const recentMessageCount = mode === "micro" ? 5 : 8;
  return {
    mode,
    extraInstruction: extraInstruction || null, //附加指令
    summary: state.summary, //摘要
    currentRequest: state.currentRequest,
    lastActivityAt: state.lastActivityAt,
    lastCompactedAt: state.lastCompactedAt,
    extractedFields: state.extractedFields,
    missingFields: state.missingFields,
    pendingFrontendAction: state.pendingFrontendAction, //待执行动作
    selectedPlanCardId: state.selectedPlanCardId, //用户选中了哪一套排期方案
    planCards: state.planCards.map(slimPlanCard), //排期方案
    conflicts: compactArrayItems(state.conflicts, 500, 12), // 时间冲突
    warnings: compactArrayItems(state.warnings, 400, 12), //警告
    agentState: slimAgentState(state.agentState), //Agent 状态标记
    toolResults: compactToolResults(state.toolResults, mode === "micro" ? 2 : 0, mode),
    recentMessages: state.messages
      .slice(-recentMessageCount)
      .map((message) => ({
        role: message.role,
        content: truncateText(message.content, 1200),
        createdAt: message.createdAt,
      })),
  };
}
// 接收摘要对象，把他序列化成格式化的json字符串，作为提示词文本，发给生成摘要的大模型
function buildCompactContextPrompt(snapshot: Record<string, unknown>): string {
  return JSON.stringify(snapshot, null, 2);
}
//提取summary 里面的文字
function parseXmlTag(content: string, tagName: "analysis" | "summary"): string {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const match = content.match(pattern);
  return match ? match[1].trim() : "";
}

function getDeepSeekApiKey(): string {
  return process.env.DEEPSEEK_API_KEY?.trim() || "";
}

function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
}

async function callDeepSeekJson(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens = 1600,
): Promise<Record<string, unknown>> {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY");
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getDeepSeekModel(),
      messages,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      thinking: { type: "disabled" },
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `DeepSeek main-flow request failed: HTTP ${response.status} ${rawText}`,
    );
  }
  const data = JSON.parse(rawText) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content || "";
  return JSON.parse(content) as Record<string, unknown>;
}
// 当调用摘要 LLM 失败、网络报错、超时的时候，不走远程大模型生成摘要； 就用这个本地拼接出来的文本，直接作为新版摘要给到会话，实现降级容错
function buildLocalCompactSummary(
  state: SchedulingSessionState,
  extraInstruction = "",
): string {
  return [
    state.summary ? `Previous summary: ${state.summary}` : "",
    state.currentRequest ? `Current request: ${state.currentRequest}` : "",
    Object.keys(state.extractedFields).length
      ? `Extracted fields: ${JSON.stringify(state.extractedFields)}`
      : "",
    state.planCards.length
      ? `Plan cards: ${state.planCards.map((plan) => `${plan.name}:${plan.taskName}`).join(", ")}`
      : "",
    state.conflicts.length
      ? `Conflicts: ${JSON.stringify(state.conflicts)}`
      : "",
    state.pendingFrontendAction
      ? `Pending frontend action: ${JSON.stringify(state.pendingFrontendAction)}`
      : "",
    extraInstruction ? `Manual instruction: ${extraInstruction}` : "",
    `Recent messages: ${state.messages
      .slice(-6)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}
//构建系统压缩提示词
function buildCompactionPrompt(
  mode: CompactionMode,
  extraInstruction = "",
): string {
  // 这里的思路更接近 Claude Code 的服务端压缩：先生成压缩后的上下文摘要，再由后端决定如何重写 session。
  return [
    "你是日程排期 Agent 的上下文压缩器。",
    "请输出严格的 XML 片段，不要 markdown，不要代码块，不要 JSON。",
    "格式必须是：<analysis>...</analysis><summary>...</summary>。",
    "<analysis> 是草稿区，只给模型自己梳理，不会进入后续上下文。",
    "<summary> 是真正进入后续上下文的结构化摘要。",
    "摘要必须保留：当前目标、截止时间、预计花费时间、偏好、缺失字段、方案卡、用户选择、批注、冲突允许记录、待办下一步、当前执行状态。",
    "摘要必须删除：重复对话、过时中间推理、已摘要的原始日志。",
    mode === "micro"
      ? "microcompact 额外要求：优先保留最近 5 条可恢复工具结果和最近 5 条会话消息，其他可重新获取内容尽量省略。"
      : "",
    extraInstruction ? `用户附加要求：${extraInstruction}` : "",
    "请把 analysis 写成简短草稿，把 summary 写成可直接接续执行的最终摘要。",
  ]
    .filter(Boolean)
    .join("\n");
}
//压缩主流程->串起来
interface CompactSessionResult {
  summary: string;
  llmUsage?: TokenUsageSummary;
}

async function compactSession(
  state: SchedulingSessionState,
  mode: CompactionMode,
  extraInstruction = "",
): Promise<CompactSessionResult> {
  if (!getDeepSeekApiKey())
    return { summary: buildLocalCompactSummary(state, extraInstruction) };
  // 生成快照副本
  const snapshot = buildCompactionSnapshot(state, mode, extraInstruction);
  const model = getDeepSeekModel();

  try {
    //发起deepseek请求
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getDeepSeekApiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: buildCompactionPrompt(mode, extraInstruction),
          },
          { role: "user", content: buildCompactContextPrompt(snapshot) },
        ],
        temperature: 0,
        max_tokens: mode === "micro" ? 1800 : 2200,
        stream: false,
        thinking: { type: "disabled" },
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `DeepSeek compaction request failed: HTTP ${response.status} ${rawText}`,
      );
    }

    const data = JSON.parse(rawText) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content || "";
    //提取summmart标签，兜底回退原始文本
    const summary = parseXmlTag(content, "summary") || content.trim();
    //摘要为空，降级本地快照
    return {
      summary: summary || buildLocalCompactSummary(state, extraInstruction),
      llmUsage: readDeepSeekTokenUsage(data, model) ?? undefined,
    };
  } catch (error) {
    console.warn(
      "[Agent Main Flow] LLM compaction failed, using local summary:",
      error instanceof Error ? error.message : error,
    );
    return { summary: buildLocalCompactSummary(state, extraInstruction) };
  }
}
// 拿到 `compactSession()` 返回好的摘要文本 `summary`，用这份摘要**重写、裁剪整个会话状态 state**，生成压缩完成之后全新的会话内存，最后持久化存储。
export async function rewriteSessionWithSummary(
  userId: string,
  state: SchedulingSessionState,
  summary: string,
  mode: CompactionMode,
  extraInstruction = "",
  options: { keepRecentMessages?: number; keepRecentToolResults?: number } = {},
): Promise<SchedulingSessionState> {
  const beforeTokens = estimateSessionTokens(state);
  const keepRecentMessages =
    options.keepRecentMessages ??
    (mode === "micro" ? MICRO_COMPACT_KEEP_MESSAGES : 0);
  const keepRecentToolResults =
    options.keepRecentToolResults ?? (mode === "micro" ? 2 : 0);
  const recentMessages =
    keepRecentMessages > 0 ? state.messages.slice(-keepRecentMessages) : [];
  const compactedToolResults = compactToolResults(state.toolResults, keepRecentToolResults, mode);
  const compactedAt = nowIso();
  const nextState: SchedulingSessionState = {
    messages: [
      {
        role: "system",
        content: [
          `Compressed scheduling memory (${mode}):`,
          summary,
          extraInstruction ? `Instruction: ${extraInstruction}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        createdAt: nowIso(),
      },
      ...recentMessages,
    ],
    summary,
    currentRequest: state.currentRequest,
    extractedFields: state.extractedFields,
    missingFields: state.missingFields,
    freeTimeSlots: [],
    planCards: state.planCards.map(slimPlanCard),
    selectedPlanCardId: state.selectedPlanCardId,
    userAnnotations: compactArrayItems(state.userAnnotations, 600, 8),
    userConflictApprovals: compactArrayItems(state.userConflictApprovals, 600, 12),
    conflicts: compactArrayItems(state.conflicts, 500, 12),
    warnings: compactArrayItems(state.warnings, 400, 12),
    agentState: slimAgentState(state.agentState),
    pendingFrontendAction: compactJsonValue(state.pendingFrontendAction, 900),
    // 这里不把压缩交给子 agent；LLM 只负责 summary，状态裁剪和重写仍由后端确定性完成。
    // 压缩后工具结果只保留可恢复占位或极少最近结果，避免原始大对象继续挤占上下文。
    toolResults: compactedToolResults,
    lastCompactedAt: compactedAt,
    lastActivityAt: compactedAt,
  };
  const afterTokens = estimateSessionTokens(nextState);
  if (afterTokens >= beforeTokens) {
    console.warn("[SessionCompression] compact result rejected because it did not reduce context", {
      userId,
      mode,
      beforeTokens,
      afterTokens,
      savedTokens: beforeTokens - afterTokens,
    });
    return state;
  }
  return replaceSession(userId, nextState);
}

export async function maybeAutoCompactSession(
  userId: string,
  state: SchedulingSessionState,
): Promise<SchedulingSessionState> {
  if (!getCompressionSettings(userId).enabled) return state;
  const estimatedTokens = estimateSessionTokens(state);
  const lastCompactedAt = state.lastCompactedAt
    ? Date.parse(state.lastCompactedAt)
    : 0;
  // 读取上一次压缩的时间，做冷却防抖
  const compactedRecently =
    lastCompactedAt > 0 &&
    Date.now() - lastCompactedAt < AUTO_COMPACT_COOLDOWN_MS;

  if (estimatedTokens < AUTO_COMPACT_TRIGGER_TOKENS || compactedRecently) {
    return state;
  }
  // 调用流水线生成摘要
  const { summary, llmUsage } = await compactSession(state, "auto");
  if (llmUsage) latestCompactionUsageByUser.set(userId, llmUsage);
  if (estimatedTokens >= AUTO_COMPACT_HARD_LIMIT_TOKENS) {
    console.warn("[Agent Main Flow] Auto compact triggered at hard limit", {
      estimatedTokens,
    });
  } else if (estimatedTokens >= AUTO_COMPACT_WARN_TOKENS) {
    console.warn(
      "[Agent Main Flow] Auto compact triggered at warning threshold",
      { estimatedTokens },
    );
  }

  return rewriteSessionWithSummary(userId, state, summary, "auto");
}
// 用户很久没说话、会话空闲了一段时间，后台做一次温和的轻量化瘦身，不是因为 Token 超标。
export async function maybeMicroCompactSession(
  userId: string,
  state: SchedulingSessionState,
): Promise<SchedulingSessionState> {
  if (!getCompressionSettings(userId).enabled) return state;
  if (!state.lastActivityAt) return state;
  const elapsed = Date.now() - Date.parse(state.lastActivityAt);
  if (!Number.isFinite(elapsed) || elapsed < MICRO_COMPACT_IDLE_MS) {
    return state;
  }

  const { summary, llmUsage } = await compactSession(state, "micro");
  if (llmUsage) latestCompactionUsageByUser.set(userId, llmUsage);
  console.warn("[Agent Main Flow] Micro compact triggered after idle gap", {
    elapsed,
  });
  return rewriteSessionWithSummary(userId, state, summary, "micro", "", {
    keepRecentMessages: MICRO_COMPACT_KEEP_MESSAGES,
    keepRecentToolResults: 5,
  });
}

export { compactSession };

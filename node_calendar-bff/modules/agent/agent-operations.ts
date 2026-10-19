import { runScheduleAgent } from './agent.orchestrator';
import type { AgentMainFlowEventHandler } from './agent-main-flow';
import { checkEventDraftWithPython } from './python-agent';
import * as eventService from '../events/events.service';
import { findEventById } from '../events/events.repository';
import type { EventPayload, EventUpdatePayload } from '../events/events.schema';
import { prisma } from '../db/prisma';
import {
  findPendingManualPauseCheckpoint,
  resolveCheckpoint,
  supersedeManualPauseCheckpoints,
  type AgentCheckpointRecord
} from './agent-checkpoint.repository';
import {
  abandonAgentJobById,
  findAgentJob,
  listAgentJobEvents,
  type AgentJobRecord
} from './agent-job.repository';
import { savePlanningSession, type AgentPlanningSessionState } from './agent-planning-session.repository';
import { semanticMatchEventByLlm, type SemanticMatchCandidate } from './intent-classifier';
import type {
  AgentAutoCreatedResponse,
  AgentClarificationResponse,
  AgentRunResponse
} from './agent.types';
import type { AgentUserPreference } from './agent.types';
import type {
  IntentClassification,
  IntentEventPatch,
  IntentEventTarget,
  IntentOperation,
  IntentOperationKind,
  ResumeQueueContext
} from './intent-classifier';

/**
 * 意图操作顺序执行器。
 *
 * 设计约定（2026-09-08 与用户对齐）：
 * 1. operations 按序执行、逐条落库，每个操作独立成功/失败，失败不牵连其他操作。
 * 2. resume_pending 排最前（intent-classifier 已保证）：先更新任务队列状态，后续操作基于新状态。
 * 3. 用户说了新任务（无 resume 操作）→ 可恢复队列里的旧任务自动标记 abandoned。
 * 4. "继续"的恢复语义：读最后一条 manual_pause 断点 → 用任务事件日志汇报"上次执行到哪里"
 *    → 恢复规划会话现场，从断点边界接着走；半途而废的步骤视为未完成，靠落库幂等防重。
 */

export interface EventSelectionOption {
  eventId: string;
  title: string;
  timeText: string;
}

/**
 * 冲突挂起（快速路径版决策卡）：检测到时间重叠时不再用一句 failed 文案打发，
 * 而是带结构化冲突列表返回，前端用主 agent 的决策卡样式让用户选：
 * 照常保留冲突 / 把冲突日程后移 N 分钟（N 可编辑）/ 取消。
 */
export interface EventConflictOption {
  eventId: string;
  title: string;
  timeText: string;
}

export interface PendingEventConflict {
  message: string;
  conflicts: EventConflictOption[];
  /** 建议后移分钟数：把冲突日程推到新日程结束之后所需的最小位移，向上取整到 5 分钟 */
  suggestedShiftMinutes: number;
  /** 原始操作（update 已带 target.eventId，重跑不再走匹配） */
  pendingOperation: IntentOperation;
}

/**
 * 歧义（第 3 级）：不再用一句报错打发用户，而是带着候选列表返回，
 * 由前端弹出选项框让用户点选，选完回传 pendingOperation + eventId 重新执行。
 */
export interface PendingEventSelection {
  message: string;
  options: EventSelectionOption[];
  /** 原始操作（target/patch 保留），用户选定 eventId 后填充 target.eventId 重跑 */
  pendingOperation: IntentOperation;
}

export interface OperationExecutionResult {
  kind: IntentOperationKind | 'upgrade_to_complex';
  status: 'succeeded' | 'failed' | 'skipped' | 'needsUserInput' | 'needsSelection' | 'needsConflictResolution';
  message: string;
  /** 增/改日程字段不足时，交给前端澄清面板补充 */
  clarification?: {
    reasons: string[];
    clarificationJson: Record<string, string>;
  };
  /** 歧义候选：status=needsSelection 时必带 */
  selection?: PendingEventSelection;
  /** 冲突挂起：status=needsConflictResolution 时必带 */
  conflict?: PendingEventConflict;
  /** resume 恢复出的业务现场（waitingConfirm / needsUserInput 响应） */
  restoredResponse?: AgentRunResponse | AgentClarificationResponse | AgentAutoCreatedResponse;
  /** resume 发现断点无业务现场时，需要用原始输入重跑 */
  rerunInput?: string;
  /** 简单增改执行中发现需要排期能力时，升级为复杂 Agent pipeline */
  upgradeTaskText?: string;
}

export interface IntentExecutionOutput {
  results: OperationExecutionResult[];
  /** 主响应：new_task / resume 产生的 Agent 响应，交给主流程做会话状态合并 */
  primary: AgentRunResponse | AgentClarificationResponse | AgentAutoCreatedResponse | null;
  /** 汇报给用户的操作摘要（每个操作一行） */
  report: string;
  /** 第一个歧义操作（若有）：主流程据此返回 needsSelection 响应，前端弹选项框 */
  pendingSelection: PendingEventSelection | null;
  /** 第一个冲突挂起操作（若有）：主流程据此返回 needsConflictResolution 响应，前端弹决策卡 */
  pendingConflict: PendingEventConflict | null;
  /** 第一个字段不完整操作（若有）：主流程返回 needsUserInput */
  pendingClarification: {
    kind: IntentOperationKind;
    message: string;
    reasons: string[];
    clarificationJson: Record<string, string>;
  } | null;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function getUserPreference(userId: string): Promise<AgentUserPreference> {
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      phone: `system-${userId}`,
      nickname: 'System User',
      preference: {
        create: {}
      }
    }
  });

  return prisma.userPreference.upsert({
    where: { userId },
    update: {},
    create: { userId },
    select: {
      preferredStartTime: true,
      preferredEndTime: true,
      dailyFocusLimitMinutes: true,
      avoidWeekends: true,
      defaultEventCategory: true,
      timezone: true
    }
  });
}

/**
 * 组装"可恢复队列"上下文，供意图识别器判断"继续"语义。
 * 可恢复队列 = 该用户最新一条 pending 的 manual_pause 断点（每用户单活）。
 */
export async function buildResumeQueueContext(userId: string): Promise<ResumeQueueContext> {
  const checkpoint = await findPendingManualPauseCheckpoint(userId);
  if (!checkpoint || !checkpoint.jobId) {
    return { hasPendingJob: false, pendingJobInput: null, pendingJobLastStep: null, pendingJobPausedAt: null };
  }

  const job = await findAgentJob(checkpoint.jobId, userId);
  const jobInput = readObject(job?.input);
  const rawInput = typeof jobInput.input === 'string' ? jobInput.input : '';
  const snapshot = readObject(checkpoint.stateSnapshot);
  const pausedAt = typeof snapshot.pausedAt === 'string' ? snapshot.pausedAt : null;

  return {
    hasPendingJob: true,
    pendingJobInput: rawInput || '（未记录原始输入）',
    pendingJobLastStep: await findLastCompletedStepMessage(checkpoint.jobId),
    pendingJobPausedAt: pausedAt
  };
}

/** 从任务事件日志读最后一步成功信息：恢复时"说出上次执行到哪里"的事实来源 */
async function findLastCompletedStepMessage(jobId: string): Promise<string | null> {
  try {
    const events = await listAgentJobEvents(jobId);
    const successEvents = events.filter((event) => event.type === 'step:success' || event.type === 'job:waiting_user');
    const last = successEvents[successEvents.length - 1];
    if (!last) return null;
    return last.message ?? last.stepId ?? null;
  } catch {
    return null;
  }
}

/**
 * 丢弃可恢复队列里的旧任务：用户输入了新需求（非"继续"），旧任务不再保留。
 * 断点置 canceled + 任务标记 abandoned。
 */
async function discardPendingManualJob(userId: string): Promise<string | null> {
  const checkpoint = await findPendingManualPauseCheckpoint(userId);
  if (!checkpoint) return null;

  const job = checkpoint.jobId ? await findAgentJob(checkpoint.jobId, userId) : null;
  const rawInput = typeof readObject(job?.input).input === 'string' ? String(readObject(job?.input).input) : '';

  await supersedeManualPauseCheckpoints(userId);
  if (checkpoint.jobId) {
    await abandonAgentJobById(checkpoint.jobId, userId);
  }
  return rawInput ? `检测到新任务，已丢弃之前未完成的任务「${rawInput}」` : '检测到新任务，已丢弃之前未完成的任务';
}

function buildProgressMessage(jobInput: string | null, lastStep: string | null): string {
  const subject = jobInput ? `「${jobInput}」` : '';
  if (lastStep) {
    return `上次任务${subject}执行到：${lastStep}。我从这里继续。`;
  }
  return `上次任务${subject}刚起步就被终止了，还没有形成进度，我重新开始执行。`;
}

async function executeResumeOperation(userId: string): Promise<OperationExecutionResult> {
  const checkpoint: AgentCheckpointRecord | null = await findPendingManualPauseCheckpoint(userId);
  if (!checkpoint) {
    return { kind: 'resume_pending', status: 'failed', message: '当前没有可恢复的任务（没有手动终止过的未完成任务，或断点已被新任务取代）' };
  }

  const snapshot = readObject(checkpoint.stateSnapshot);
  const result = readObject(snapshot.result);
  const planningSession = readObject(snapshot.planningSession);
  const runId = checkpoint.runId;

  // 上次已经写入日历 = 任务实际已完成，没有可恢复的步骤
  if (result.status === 'autoCreated') {
    const createdCount = typeof result.createdCount === 'number' ? result.createdCount : 0;
    return {
      kind: 'resume_pending',
      status: 'skipped',
      message: `上次任务已经完成并写入日历（${createdCount} 条日程），没有需要恢复的步骤。`
    };
  }

  const job: AgentJobRecord | null = checkpoint.jobId ? await findAgentJob(checkpoint.jobId, userId) : null;
  const jobInput = readObject(job?.input);
  const rawInput = typeof jobInput.input === 'string' ? jobInput.input : null;
  const lastStep = await findLastCompletedStepMessage(checkpoint.jobId ?? '');
  const progressMessage = buildProgressMessage(rawInput, lastStep);

  // 恢复规划会话现场（方案卡 / 排期状态），让后续确认、批注、写入日历都能接上
  if (
    planningSession.userId === userId &&
    planningSession.rawInput &&
    planningSession.userPreference &&
    planningSession.normalizedContext &&
    planningSession.atomicPlan
  ) {
    await savePlanningSession(runId, planningSession as unknown as AgentPlanningSessionState, 'waitingConfirm');
  }

  // 消费断点：恢复后该断点不再算"可恢复队列"成员
  await resolveCheckpoint({ runId, userId, checkpointId: checkpoint.id });

  if (result.status === 'waitingConfirm' || result.status === 'needsUserInput') {
    return {
      kind: 'resume_pending',
      status: 'succeeded',
      message: progressMessage,
      restoredResponse: result as unknown as AgentRunResponse | AgentClarificationResponse
    };
  }

  // 断点里没有业务现场（刚开始就被停）：用原始输入从头重跑
  if (rawInput && rawInput.trim()) {
    return {
      kind: 'resume_pending',
      status: 'succeeded',
      message: progressMessage,
      rerunInput: rawInput
    };
  }

  return { kind: 'resume_pending', status: 'failed', message: '断点信息不完整（既没有业务现场也没有原始输入），无法恢复' };
}

async function executeNewTaskOperation(
  userId: string,
  input: string,
  operation: IntentOperation,
  clarificationJson: unknown,
  onEvent?: AgentMainFlowEventHandler
): Promise<OperationExecutionResult> {
  // 新任务 → 自动丢弃可恢复队列里的旧任务（用户输入了新需求）
  const discardedMessage = await discardPendingManualJob(userId);
  const taskText = operation.taskText?.trim() || input;
  // clarificationJson 由调用方保证只传给本轮第一个 new_task：
  // 澄清表单就是上一轮 needsUserInput 为"当前这个任务"发的，
  // 用户点"提交补充信息"时无论 LLM 把 taskText 改写成什么，补充信息都属于它。
  // （旧实现靠 taskText === 原文 判断，LLM 按 prompt 把"帮我准备报告"剥离成"准备报告"后
  //   永远不相等 → 补充信息被丢弃 → 排期器再次追问同样字段 → 前端表现为"提交无反应"）

  const result = await runScheduleAgent({
    userId,
    input: taskText,
    clarificationJson,
    onEvent
  });
  return {
    kind: 'new_task',
    status: 'succeeded',
    message: discardedMessage ?? '',
    restoredResponse: result
  };
}

const EVENT_CATEGORIES = ['工作', '学习', '生活', '面试'];
const EVENT_PRIORITIES = ['高', '中', '低'];
const EVENT_STATUSES = ['未开始', '进行中', '已完成', '已延期'];

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeCreatePayload(operation: IntentOperation): EventPayload {
  const event = readObject(operation.event);
  const title = typeof event.title === 'string' ? event.title.trim() : '';
  if (!title) throw new Error('创建日程缺少标题');

  const startTime = parseIsoDate(event.startTime);
  if (!startTime) throw new Error('创建日程缺少有效的开始时间');
  const explicitEnd = parseIsoDate(event.endTime);
  const durationMinutes = typeof event.durationMinutes === 'number' && event.durationMinutes > 0 ? event.durationMinutes : 15;
  const endTime = explicitEnd ?? new Date(startTime.getTime() + durationMinutes * 60 * 1000);
  if (endTime <= startTime) throw new Error('结束时间必须晚于开始时间');

  const category = typeof event.category === 'string' && EVENT_CATEGORIES.includes(event.category) ? event.category : '生活';
  const priority = typeof event.priority === 'string' && EVENT_PRIORITIES.includes(event.priority) ? event.priority : '中';
  const status = typeof event.status === 'string' && EVENT_STATUSES.includes(event.status) ? event.status : '未开始';
  const location = typeof event.location === 'string' && event.location.trim() ? event.location.trim() : null;
  const note = typeof event.note === 'string' && event.note.trim() ? event.note.trim() : null;

  return {
    title,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    location,
    category: category as EventPayload['category'],
    priority: priority as EventPayload['priority'],
    note,
    status: status as EventPayload['status']
  };
}

interface ResolvedEventRange {
  start: Date;
  end: Date;
}

function resolveSearchRange(target: IntentEventTarget, defaultDays: number): ResolvedEventRange {
  const rangeStart = parseIsoDate(target.rangeStart);
  const rangeEnd = parseIsoDate(target.rangeEnd);
  if (rangeStart && rangeEnd && rangeStart < rangeEnd) {
    return { start: rangeStart, end: rangeEnd };
  }
  const date = parseIsoDate(target.date);
  if (date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    return { start: dayStart, end: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) };
  }
  const now = new Date();
  return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: new Date(now.getTime() + defaultDays * 24 * 60 * 60 * 1000) };
}

function normalizeTitleKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\W_]+/g, '');
}

function matchEventsByTitle(events: Array<Record<string, unknown>>, title?: string): Array<Record<string, unknown>> {
  // 标题为空时不做任何匹配（返回空数组），避免把全部日程误报为"同名/相似"
  if (!title?.trim()) return [];
  const key = normalizeTitleKey(title);
  if (!key) return [];
  return events.filter((event) => {
    const eventKey = normalizeTitleKey(event.title);
    return eventKey.includes(key) || key.includes(eventKey);
  });
}

// 回复里的时间展示固定按用户时区（Asia/Shanghai），与服务器部署时区无关
const eventLineFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

function formatEventLine(event: Record<string, unknown>): string {
  const start = event.startTime instanceof Date ? event.startTime : parseIsoDate(event.startTime);
  const end = event.endTime instanceof Date ? event.endTime : parseIsoDate(event.endTime);
  const format = (date: Date | null) => {
    if (!date) return '?';
    const parts = eventLineFormatter.formatToParts(date);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '??';
    return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
  };
  return `「${String(event.title ?? '未命名')}」${format(start)}~${format(end)}`;
}

async function searchTargetEvents(
  userId: string,
  target: IntentEventTarget
): Promise<Array<Record<string, unknown>>> {
  const range = resolveSearchRange(target, 14);
  const events = (await eventService.listEvents(userId, {
    start: range.start.toISOString(),
    end: range.end.toISOString()
  })) as Array<Record<string, unknown>>;
  if (target.eventId) {
    return events.filter((event) => event.id === target.eventId);
  }
  return matchEventsByTitle(events, target.title);
}

/**
 * 本周时间窗（周一 00:00 → 下周一 00:00，Asia/Shanghai）。
 * 语义匹配的候选池按用户要求收窄到本周，避免把三周前的旧日程也喂给 LLM。
 */
function currentWeekRange(now = new Date()): { start: Date; end: Date } {
  const SHIFT = 8 * 60 * 60 * 1000; // Asia/Shanghai 固定 +8（无夏令时）
  const local = new Date(now.getTime() + SHIFT); // 拔到 +8 后按 UTC 数学算"本地"日期
  const day = local.getUTCDay(); // 0=周日
  const diffToMonday = (day + 6) % 7; // 周一=0
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - diffToMonday);
  const start = new Date(mondayLocal - SHIFT); // 拔回真实 UTC
  return { start, end: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

async function listEventsInRange(userId: string, start: Date, end: Date): Promise<Array<Record<string, unknown>>> {
  return (await eventService.listEvents(userId, {
    start: start.toISOString(),
    end: end.toISOString()
  })) as Array<Record<string, unknown>>;
}

function toSelectionOptions(events: Array<Record<string, unknown>>): EventSelectionOption[] {
  return events.slice(0, 10).map((event) => ({
    eventId: String(event.id),
    title: String(event.title ?? '未命名'),
    timeText: formatEventLine(event).replace(/^「.*?」/, '').trim()
  }));
}

type TargetResolution =
  | { matched: Record<string, unknown> }
  | { needsSelection: EventSelectionOption[] };

/**
 * 三级日程定位（2026-09-08 与用户对齐）：
 * 1. 子串匹配唯一命中 → 直接用，零额外 LLM 调用（主路径）。
 * 2. 0 命中 → 把本周候选 + 用户原话交给 LLM 语义匹配（同义词/改写/指代）。
 * 3. 仍不唯一（多条子串命中 / LLM 判 ambiguous）→ 返回候选列表，
 *    由前端弹选项框让用户点选，不猜。
 */
async function resolveTargetEvent(
  userId: string,
  rawInput: string,
  target: IntentEventTarget,
  operation: IntentOperation
): Promise<TargetResolution> {
  // 用户已在选项框点定：eventId 是权威定位，直查不走搜索窗（否则窗口边界会漏）
  if (target.eventId?.trim()) {
    const event = await findEventById(userId, target.eventId.trim());
    if (!event) {
      throw new Error('没有找到符合描述的日程');
    }
    return { matched: event as unknown as Record<string, unknown> };
  }

  // 第 1 级：子串匹配
  const matches = await searchTargetEvents(userId, target);
  if (matches.length === 1) {
    return { matched: matches[0] };
  }
  if (matches.length > 1) {
    return { needsSelection: toSelectionOptions(matches) };
  }

  // 第 2 级：LLM 语义匹配（候选池 = 本周日程）
  const week = currentWeekRange();
  const weekEvents = await listEventsInRange(userId, week.start, week.end);
  if (weekEvents.length === 0) {
    throw new Error('没有找到符合描述的日程');
  }
  const candidates: SemanticMatchCandidate[] = weekEvents.map((event) => ({
    eventId: String(event.id),
    title: String(event.title ?? '未命名'),
    timeText: formatEventLine(event)
  }));
  const semantic = await semanticMatchEventByLlm(rawInput, candidates);
  if (semantic.decision === 'matched' && semantic.eventId) {
    const event = weekEvents.find((candidate) => String(candidate.id) === semantic.eventId);
    if (event) {
      return { matched: event };
    }
  }
  if (semantic.decision === 'ambiguous') {
    // 第 3 级：LLM 也定不了 → 弹选项框
    return { needsSelection: toSelectionOptions(weekEvents) };
  }
  const titleHint = target.title?.trim() ? `（关键词「${target.title.trim()}」）` : '';
  throw new Error(`没有找到符合描述的日程${titleHint}，可以试试换种说法或补充日期`);
}

/** 无定位条件时给出明确提示，而不是拿全部日程充数 */
function requireTargetKey(target: IntentEventTarget, action: string): void {
  if (!target.eventId && !target.title?.trim()) {
    throw new Error(`没有给出要${action}的日程名称，请补充标题关键词（比如"把洗澡推迟一下"里的"洗澡"）`);
  }
}

function buildNeedsUserInputResult(
  kind: IntentOperationKind,
  message: string,
  reasons: string[],
  clarificationJson: Record<string, string>
): OperationExecutionResult {
  return {
    kind,
    status: 'needsUserInput',
    message,
    clarification: {
      reasons,
      clarificationJson
    }
  };
}

function looksSchedulableTaskText(value: string): boolean {
  return /安排|排期|复习|学习|准备|写|做|开发|设计|调研|备考|刷题|论文|报告|项目/.test(value);
}

function hasDurationHint(value: Record<string, unknown>, rawInput: string): boolean {
  if (typeof value.durationMinutes === 'number' && value.durationMinutes > 0) return true;
  return /\d+\s*(分钟|小时|h|H|min|mins)|半小时|一小时|两小时|三小时|四小时/.test(rawInput);
}

function buildUpgradeToComplexResult(taskText: string): OperationExecutionResult {
  return {
    kind: 'upgrade_to_complex',
    status: 'succeeded',
    message: '当前输入更像需要结合空闲时间安排的任务，已升级为复杂排期流程。',
    upgradeTaskText: taskText
  };
}

interface DetectedConflict {
  eventId: string;
  title: string;
  start: Date;
  end: Date;
  message: string;
}

/**
 * 单条日程的冲突检测 —— 与 Python 排期器的 check_schedule_conflicts 同语义：
 * 区间重叠判断一致（startA < endB && startB < endA），文案词汇一致
 * （「A」与已有日程「B」时间重叠），"允许冲突仍排期"等价于那边的 approvedOverlap。
 * 区别只是不走 Python 全排期流程，快路径在 BFF 本地现算。
 */
export async function detectEventConflicts(
  userId: string,
  title: string,
  start: Date,
  end: Date,
  excludeEventId?: string
): Promise<DetectedConflict[]> {
  // 前后各留 1 天缓冲，避免"跨过窗口边界的日程"漏查，重叠判断在本地做
  const bufferMs = 24 * 60 * 60 * 1000;
  const events = await listEventsInRange(userId, new Date(start.getTime() - bufferMs), new Date(end.getTime() + bufferMs));
  const conflicts: DetectedConflict[] = [];
  for (const event of events) {
    if (excludeEventId && String(event.id) === excludeEventId) continue;
    const eventStart = event.startTime instanceof Date ? event.startTime : parseIsoDate(event.startTime);
    const eventEnd = event.endTime instanceof Date ? event.endTime : parseIsoDate(event.endTime);
    if (!eventStart || !eventEnd) continue;
    // 与 Python _intervals_overlap 相同的半开区间判断
    if (start.getTime() < eventEnd.getTime() && eventStart.getTime() < end.getTime()) {
      conflicts.push({
        eventId: String(event.id),
        title: String(event.title ?? '已有日程'),
        start: eventStart,
        end: eventEnd,
        message: `「${title || '新日程'}」与已有日程「${String(event.title ?? '已有日程')}」时间重叠（${formatEventLine(event)}）`
      });
    }
  }
  return conflicts;
}

/**
 * 建议后移分钟数：把所有冲突日程推到新时段结束之后所需的最小位移，
 * 向上取整到 5 分钟（用户可在决策卡里自行改）。
 */
function suggestShiftMinutes(conflicts: DetectedConflict[], newEnd: Date): number {
  let required = 0;
  for (const conflict of conflicts) {
    required = Math.max(required, newEnd.getTime() - conflict.start.getTime());
  }
  const minutes = Math.ceil(required / (60 * 1000));
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

function buildPendingConflict(
  kind: IntentOperationKind,
  conflicts: DetectedConflict[],
  suggestedShiftMinutes: number,
  pendingOperation: IntentOperation
): OperationExecutionResult {
  const lines = conflicts.map((conflict) => `「${conflict.title}」${formatEventLine({ title: conflict.title, startTime: conflict.start, endTime: conflict.end })}`).join('；');
  return {
    kind,
    status: 'needsConflictResolution',
    message: `检测到时间冲突：${lines}。可以选择保留冲突、把原有日程后移，或取消。`,
    conflict: {
      message: `检测到时间冲突，共 ${conflicts.length} 条日程与目标时段重叠`,
      conflicts: conflicts.map((conflict) => ({
        eventId: conflict.eventId,
        title: conflict.title,
        timeText: formatEventLine({ title: conflict.title, startTime: conflict.start, endTime: conflict.end })
      })),
      suggestedShiftMinutes,
      pendingOperation
    }
  };
}

function readPythonConflictTime(value: unknown): Date | null {
  return parseIsoDate(value);
}

function buildConflictsFromPythonCheck(result: unknown): DetectedConflict[] {
  const record = readObject(result);
  const conflictCheckResult = readObject(record.conflictCheckResult);
  const rawConflicts = Array.isArray(conflictCheckResult.conflicts) ? conflictCheckResult.conflicts : [];
  return rawConflicts
    .map((item) => {
      const conflict = readObject(item);
      if (conflict.severity === 'info' || conflict.approvedByUser === true) return null;
      const eventId = typeof conflict.eventId === 'string' ? conflict.eventId.trim() : '';
      const title = typeof conflict.eventTitle === 'string' && conflict.eventTitle.trim() ? conflict.eventTitle.trim() : '已有日程';
      const start = readPythonConflictTime(conflict.eventStartIso);
      const end = readPythonConflictTime(conflict.eventEndIso);
      if (!eventId || !start || !end) return null;
      return {
        eventId,
        title,
        start,
        end,
        message: typeof conflict.message === 'string' ? conflict.message : `与已有日程「${title}」时间重叠`
      };
    })
    .filter((item): item is DetectedConflict => item !== null);
}

interface EventDraftConflictGateInput {
  kind: 'event_create' | 'event_update';
  userId: string;
  rawInput: string;
  title: string;
  start: Date;
  end: Date;
  allowConflict: boolean;
  pendingOperation: IntentOperation;
  excludeEventId?: string;
}

/**
 * 简单日程草案的后半段调度关口。
 *
 * 简单提醒/单条日程不会进入完整 Python Agent 排期主循环；它们会先在 BFF
 * 构造出确定的日程草案，然后从这里进入与主 Agent 后半段语义一致的流程：
 * 查询已有日程 -> 冲突检测 -> 必要时挂起为冲突决策卡 -> 用户确认后再落库。
 */
async function runEventDraftConflictGate(input: EventDraftConflictGateInput): Promise<OperationExecutionResult | null> {
  if (input.allowConflict) return null;

  const userPreference = await getUserPreference(input.userId);
  const agentCheck = await checkEventDraftWithPython({
    userId: input.userId,
    rawInput: input.rawInput,
    userPreference,
    draft: {
      taskId: `${input.kind}:${input.title}`,
      title: input.title,
      startIso: input.start.toISOString(),
      endIso: input.end.toISOString(),
      excludeEventId: input.excludeEventId
    }
  });

  if (agentCheck.status === 'failed') {
    throw new Error((agentCheck.errors ?? []).join('；') || '单条日程 Agent 检查失败');
  }

  const conflicts = buildConflictsFromPythonCheck(agentCheck);
  if (conflicts.length === 0) return null;

  return buildPendingConflict(input.kind, conflicts, suggestShiftMinutes(conflicts, input.end), input.pendingOperation);
}

async function executeEventCreate(userId: string, rawInput: string, operation: IntentOperation): Promise<OperationExecutionResult> {
  const event = readObject(operation.event);
  const missing: Record<string, string> = {};
  if (typeof event.title !== 'string' || !event.title.trim()) missing.title = '';
  if (!parseIsoDate(event.startTime)) missing.startTime = '';
  if (!parseIsoDate(event.endTime) && !(typeof event.durationMinutes === 'number' && event.durationMinutes > 0)) {
    missing.endTime = '';
  }
  if (Object.keys(missing).length > 0) {
    if (!parseIsoDate(event.startTime) && hasDurationHint(event, rawInput) && looksSchedulableTaskText(rawInput)) {
      return buildUpgradeToComplexResult(typeof event.title === 'string' && event.title.trim() ? event.title.trim() : rawInput);
    }
    return buildNeedsUserInputResult(
      'event_create',
      '创建日程所需信息还不完整，请补充后再继续。',
      Object.keys(missing).map((field) => `event_create 缺少必要字段：${field}`),
      missing
    );
  }

  const payload = normalizeCreatePayload(operation);
  const allowConflict = operation.allowConflict === true || operation.event?.allowConflict === true;
  const start = parseIsoDate(payload.startTime);
  const end = parseIsoDate(payload.endTime);
  if (!start || !end) {
    throw new Error('创建日程缺少有效的时间范围');
  }
  const conflictGateResult = await runEventDraftConflictGate({
    kind: 'event_create',
    userId,
    rawInput,
    title: payload.title,
    start,
    end,
    allowConflict,
    pendingOperation: operation
  });
  if (conflictGateResult) {
    return conflictGateResult;
  }
  const agentRunId = `intent-${Date.now()}`;
  const created = await eventService.bulkCreateEvents(userId, { events: [payload], agentRunId });
  return {
    kind: 'event_create',
    status: 'succeeded',
    message: `已创建日程：${formatEventLine(created[0] as Record<string, unknown>)}`
  };
}

async function executeEventQuery(userId: string, operation: IntentOperation): Promise<OperationExecutionResult> {
  const target = operation.target ?? {};
  const range = resolveSearchRange(target, 7);
  const events = (await eventService.listEvents(userId, {
    start: range.start.toISOString(),
    end: range.end.toISOString()
  })) as Array<Record<string, unknown>>;
  // 无标题无 id = 查这个时间段内的全部日程；有标题才做名称匹配
  const matched =
    target.eventId
      ? events.filter((event) => event.id === target.eventId)
      : target.title?.trim()
        ? matchEventsByTitle(events, target.title)
        : events;
  if (matched.length === 0) {
    return { kind: 'event_query', status: 'succeeded', message: '这个时间段内没有找到日程' };
  }
  const lines = matched.slice(0, 20).map(formatEventLine);
  return {
    kind: 'event_query',
    status: 'succeeded',
    message: `找到 ${matched.length} 条日程：${lines.join('；')}`
  };
}

function buildUpdatePayload(patch: IntentEventPatch | undefined, allowEmpty = false): EventUpdatePayload {
  const record = readObject(patch);
  const payload: EventUpdatePayload = {};
  if (typeof record.title === 'string' && record.title.trim()) payload.title = record.title.trim();
  const startTime = parseIsoDate(record.startTime);
  if (startTime) payload.startTime = startTime.toISOString();
  const endTime = parseIsoDate(record.endTime);
  if (endTime) payload.endTime = endTime.toISOString();
  if (typeof record.location === 'string') payload.location = record.location.trim() || null;
  if (typeof record.note === 'string') payload.note = record.note.trim() || null;
  if (typeof record.status === 'string' && EVENT_STATUSES.includes(record.status)) {
    payload.status = record.status as EventUpdatePayload['status'];
  }
  if (typeof record.priority === 'string' && EVENT_PRIORITIES.includes(record.priority)) {
    payload.priority = record.priority as EventUpdatePayload['priority'];
  }
  if (typeof record.category === 'string' && EVENT_CATEGORIES.includes(record.category)) {
    payload.category = record.category as EventUpdatePayload['category'];
  }
  if (Object.keys(payload).length === 0 && !allowEmpty) {
    throw new Error('没有给出任何要修改的内容');
  }
  return payload;
}

async function executeEventUpdate(userId: string, rawInput: string, operation: IntentOperation): Promise<OperationExecutionResult> {
  const target = operation.target ?? {};
  if (!target.eventId && !target.title?.trim()) {
    return buildNeedsUserInputResult(
      'event_update',
      '无法确定要修改哪条日程，请补充日程名称或日期。',
      ['event_update 缺少目标日程'],
      { eventTitle: '' }
    );
  }
  const resolution = await resolveTargetEvent(userId, rawInput, target, operation);
  if ('needsSelection' in resolution) {
    return buildNeedsSelectionResult('event_update', resolution.needsSelection, operation);
  }
  const match = resolution.matched;
  const eventId = String(match.id);

  const patch = operation.patch ?? {};
  const shiftMinutes =
    typeof patch.shiftMinutes === 'number' && Number.isFinite(patch.shiftMinutes) && patch.shiftMinutes !== 0
      ? Math.round(patch.shiftMinutes)
      : 0;
  const payload = buildUpdatePayload(patch, shiftMinutes !== 0);

  if (shiftMinutes !== 0) {
    // 相对时间修改（"推迟/提前 N"）：基于日程当前时间计算新时间，保持原时长
    const existingStart = match.startTime instanceof Date ? match.startTime : parseIsoDate(match.startTime);
    const existingEnd = match.endTime instanceof Date ? match.endTime : parseIsoDate(match.endTime);
    if (!existingStart || !existingEnd) {
      throw new Error('日程时间信息不完整，无法做相对推迟/提前');
    }
    payload.startTime = new Date(existingStart.getTime() + shiftMinutes * 60 * 1000).toISOString();
    payload.endTime = new Date(existingEnd.getTime() + shiftMinutes * 60 * 1000).toISOString();
  }

  // 新时段冲突检测（与创建同语义）；用户明说"冲突也改/照常"则放行
  const allowConflict = operation.allowConflict === true;
  if (!allowConflict && (payload.startTime || payload.endTime)) {
    const newStart = parseIsoDate(payload.startTime) ?? (match.startTime instanceof Date ? match.startTime : parseIsoDate(match.startTime));
    const newEnd = parseIsoDate(payload.endTime) ?? (match.endTime instanceof Date ? match.endTime : parseIsoDate(match.endTime));
    if (newStart && newEnd) {
      // pendingOperation 固化 eventId + 绝对时间，重跑时不再走定位匹配
      const conflictGateResult = await runEventDraftConflictGate({
        kind: 'event_update',
        userId,
        rawInput,
        title: payload.title ?? String(match.title ?? ''),
        start: newStart,
        end: newEnd,
        allowConflict,
        excludeEventId: eventId,
        pendingOperation: {
          kind: 'event_update',
          target: { ...target, eventId },
          patch: { ...readObject(operation.patch), startTime: newStart.toISOString(), endTime: newEnd.toISOString() }
        }
      });
      if (conflictGateResult) {
        return conflictGateResult;
      }
    }
  }

  const updated = await eventService.updateEvent(userId, eventId, payload);
  const line = formatEventLine(updated as Record<string, unknown>);
  const message =
    shiftMinutes > 0
      ? `已把日程推迟 ${shiftMinutes} 分钟：${line}`
      : shiftMinutes < 0
        ? `已把日程提前 ${Math.abs(shiftMinutes)} 分钟：${line}`
        : `已修改日程：${line}`;
  return { kind: 'event_update', status: 'succeeded', message };
}

async function executeEventDelete(userId: string, rawInput: string, operation: IntentOperation): Promise<OperationExecutionResult> {
  const target = operation.target ?? {};
  requireTargetKey(target, '删除');
  const resolution = await resolveTargetEvent(userId, rawInput, target, operation);
  if ('needsSelection' in resolution) {
    return buildNeedsSelectionResult('event_delete', resolution.needsSelection, operation);
  }
  const match = resolution.matched;
  await eventService.deleteEvent(userId, String(match.id));
  return {
    kind: 'event_delete',
    status: 'succeeded',
    message: `已删除日程：${formatEventLine(match)}`
  };
}

function buildNeedsSelectionResult(
  kind: IntentOperationKind,
  options: EventSelectionOption[],
  operation: IntentOperation
): OperationExecutionResult {
  const lines = options.map((option, index) => `${index + 1}. 「${option.title}」${option.timeText}`).join('；');
  return {
    kind,
    status: 'needsSelection',
    message: `找到 ${options.length} 条相似日程，请选择要操作的哪一条：${lines}`,
    selection: {
      message: `找到 ${options.length} 条相似日程，请选择要${kind === 'event_delete' ? '删除' : '修改'}的哪一条`,
      options,
      pendingOperation: operation
    }
  };
}

/**
 * 顺序执行全部意图操作。
 * resume_pending 已由意图识别器排在最前；这里再把 resume 产生的 rerunInput
 * 转成一次 new_task 执行（断点无业务现场时的从头重跑）。
 */
export async function executeIntentOperations(input: {
  userId: string;
  rawInput: string;
  classification: IntentClassification;
  clarificationJson?: unknown;
  onEvent?: AgentMainFlowEventHandler;
}): Promise<IntentExecutionOutput> {
  const { userId, rawInput, classification, clarificationJson, onEvent } = input;
  const results: OperationExecutionResult[] = [];
  let primary: IntentExecutionOutput['primary'] = null;
  let pendingSelection: PendingEventSelection | null = null;
  let pendingConflict: PendingEventConflict | null = null;
  let pendingClarification: IntentExecutionOutput['pendingClarification'] = null;

  const operations = [...classification.operations];
  // 澄清表单只服务一个任务：clarificationJson 只交给本轮第一个 new_task，用后即焚
  let clarificationConsumed = false;
  let index = 0;
  while (index < operations.length) {
    const operation = operations[index];
    index += 1;

    let result: OperationExecutionResult;
    try {
      switch (operation.kind) {
        case 'resume_pending':
          result = await executeResumeOperation(userId);
          if (result.rerunInput && !operations.some((op) => op.kind === 'new_task')) {
            // 断点无业务现场：用原始输入作为新任务重跑
            operations.push({ kind: 'new_task', taskText: result.rerunInput });
          }
          if (result.restoredResponse) {
            primary = result.restoredResponse;
          }
          break;
        case 'new_task': {
          const passClarification = !clarificationConsumed ? clarificationJson : undefined;
          clarificationConsumed = true;
          result = await executeNewTaskOperation(userId, rawInput, operation, passClarification, onEvent);
          if (result.restoredResponse) {
            primary = result.restoredResponse;
          }
          break;
        }
        case 'event_create':
          result = await executeEventCreate(userId, rawInput, operation);
          break;
        case 'event_query':
          result = await executeEventQuery(userId, operation);
          break;
        case 'event_update':
          result = await executeEventUpdate(userId, rawInput, operation);
          break;
        case 'event_delete':
          result = await executeEventDelete(userId, rawInput, operation);
          break;
        case 'chat':
          result = { kind: 'chat', status: 'succeeded', message: operation.answer ?? '' };
          break;
        default:
          result = { kind: operation.kind, status: 'failed', message: '未知操作类型' };
      }
    } catch (error) {
      // 每个操作独立成败：失败不牵连后续操作
      result = {
        kind: operation.kind,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      };
    }
    results.push(result);
    if (result.upgradeTaskText) {
      const upgraded = await executeNewTaskOperation(userId, rawInput, { kind: 'new_task', taskText: result.upgradeTaskText }, undefined, onEvent);
      results.push(upgraded);
      if (upgraded.restoredResponse) {
        primary = upgraded.restoredResponse;
      }
      continue;
    }
    // 第一个歧义操作会被带回给用户做选择（其余操作照常独立执行）
    if (result.status === 'needsSelection' && result.selection && !pendingSelection) {
      pendingSelection = result.selection;
    }
    // 第一个冲突操作挂起为决策卡（其余操作照常独立执行）
    if (result.status === 'needsConflictResolution' && result.conflict && !pendingConflict) {
      pendingConflict = result.conflict;
    }
    if (result.status === 'needsUserInput' && result.kind !== 'upgrade_to_complex' && result.clarification && !pendingClarification) {
      pendingClarification = {
        kind: result.kind,
        message: result.message,
        reasons: result.clarification.reasons,
        clarificationJson: result.clarification.clarificationJson
      };
    }
  }

  const report = results
    .filter((result) => result.message)
    .map((result) => result.message)
    .join('\n');

  return { results, primary, report, pendingSelection, pendingConflict, pendingClarification };
}

/**
 * 用户在选项框里点定某条日程后，带着 eventId 重跑该操作。
 * 仅供 POST /agent/event-selection 调用：只接受 event_update / event_delete，
 * 不允许 new_task / resume（否则会绕过意图识别和任务队列语义）。
 */
export async function executeSelectedEventOperation(
  userId: string,
  operation: IntentOperation,
  eventId: string
): Promise<IntentExecutionOutput> {
  if (operation.kind !== 'event_update' && operation.kind !== 'event_delete') {
    throw new Error('只支持日程修改/删除操作的选择重跑');
  }
  if (!eventId.trim()) {
    throw new Error('缺少日程选择');
  }
  const rerunOperation: IntentOperation = {
    ...operation,
    target: { ...(operation.target ?? {}), eventId: eventId.trim(), title: undefined }
  };
  return executeIntentOperations({
    userId,
    rawInput: `用户已选择日程 ${eventId}`,
    classification: {
      operations: [rerunOperation],
      reason: 'event-selection',
      wantsResume: false,
      fallbackUsed: false
    }
  });
}

/**
 * 用户在冲突决策卡上做出选择后执行：
 * - keep_conflict：保留冲突照常执行原操作（等价"冲突也安排"）
 * - shift_existing：先把冲突日程整体后移 shiftMinutes（保持各自时长），再执行原操作
 * - cancel：什么都不动
 * 仅供 POST /agent/event-conflict 调用：只接受 event_create / event_update。
 */
export async function resolveEventConflict(
  userId: string,
  payload: {
    action: 'keep_conflict' | 'shift_existing' | 'cancel';
    shiftMinutes?: number;
    conflictEventIds?: string[];
    operation: IntentOperation;
  }
): Promise<string> {
  const { action, operation } = payload;

  if (action === 'cancel') {
    return '已取消本次操作，日历未做任何改动。';
  }

  if (operation.kind !== 'event_create' && operation.kind !== 'event_update') {
    throw new Error('只支持日程创建/修改操作的冲突决策');
  }

  if (action === 'shift_existing') {
    const shiftMinutes = Math.round(Number(payload.shiftMinutes));
    if (!Number.isFinite(shiftMinutes) || shiftMinutes <= 0) {
      throw new Error('后移分钟数必须是大于 0 的数字');
    }
    const eventIds = (payload.conflictEventIds ?? []).map((id) => id.trim()).filter(Boolean);
    if (eventIds.length === 0) {
      throw new Error('缺少冲突日程列表');
    }
    const shiftMs = shiftMinutes * 60 * 1000;
    const shiftedLines: string[] = [];
    for (const eventId of eventIds) {
      const event = await findEventById(userId, eventId);
      if (!event) continue; // 可能已被并发删除：跳过而不是整体失败
      const start = event.startTime instanceof Date ? event.startTime : parseIsoDate(event.startTime);
      const end = event.endTime instanceof Date ? event.endTime : parseIsoDate(event.endTime);
      if (!start || !end) continue;
      const shifted = (await eventService.updateEvent(userId, eventId, {
        startTime: new Date(start.getTime() + shiftMs).toISOString(),
        endTime: new Date(end.getTime() + shiftMs).toISOString()
      })) as Record<string, unknown>;
      shiftedLines.push(formatEventLine(shifted));
    }
    if (shiftedLines.length === 0) {
      throw new Error('冲突日程已不存在，无法后移');
    }

    // 原有日程已后移，直接执行原操作（保留 allowConflict 以防残余重叠）
    const rerun = await executeIntentOperations({
      userId,
      rawInput: '用户已选择后移冲突日程',
      classification: {
        operations: [{ ...operation, allowConflict: true }],
        reason: 'event-conflict/shift_existing',
        wantsResume: false,
        fallbackUsed: false
      }
    });
    const shiftMessage = `已把 ${shiftedLines.length} 条原有日程后移 ${shiftMinutes} 分钟：${shiftedLines.join('；')}。`;
    const rerunReport = rerun.results.map((result) => result.message).filter(Boolean).join('\n');
    return rerunReport ? `${shiftMessage}\n${rerunReport}` : shiftMessage;
  }

  // keep_conflict：保留冲突照常执行
  const rerun = await executeIntentOperations({
    userId,
    rawInput: '用户已确认保留冲突',
    classification: {
      operations: [{ ...operation, allowConflict: true }],
      reason: 'event-conflict/keep_conflict',
      wantsResume: false,
      fallbackUsed: false
    }
  });
  const report = rerun.results.map((result) => result.message).filter(Boolean).join('\n');
  return report || '已按保留冲突执行操作。';
}

import { prisma } from '../db/prisma';
import { parseTaskWithDeepSeek } from './deepseek';
import { extractAgentFieldsWithDeepSeek, type AgentFieldExtraction } from './field-extractor';
import { planAtomicTasksWithPython, resumeScheduleWithPython, sendTaskToPythonAgent, validateAgentFieldsWithPython, type PythonPlanResult } from './python-agent';
import type { AgentClarificationResponse, AgentDecisionResponse, AgentRunResponse, AgentUserPreference, ParsedScheduleTask, ParsedSubtask, PlanItem, SchedulePlanOption } from './agent.types';
import type { AgentMainFlowEventHandler } from './agent-main-flow';
import { findPlanningSession, savePlanningSession, updatePlanningSessionAtomicPlan } from './agent-planning-session.repository';

interface RunScheduleAgentInput {
  userId: string;
  input: string;
  clarificationJson?: unknown;
  onEvent?: AgentMainFlowEventHandler;
}

type UserPreferenceLike = AgentUserPreference;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatClock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function formatLocalIso(date: Date): string {
  return `${formatDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}+08:00`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function extractTotalMinutes(input: string): number {
  const hourMatch = input.match(/(\d+(?:\.\d+)?)\s*(\u5c0f\u65f6|h|H)/);
  if (hourMatch) return Math.max(30, Math.round(Number(hourMatch[1]) * 60));

  const minuteMatch = input.match(/(\d+)\s*(\u5206\u949f|min)/i);
  if (minuteMatch) return Math.max(30, Math.round(Number(minuteMatch[1])));

  return 120;
}

function extractTaskName(input: string): string {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return 'Agent task';
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
}

function normalizeCategory(value: string): string {
  return ['\u5de5\u4f5c', '\u5b66\u4e60', '\u751f\u6d3b', '\u9762\u8bd5'].includes(value) ? value : '\u5b66\u4e60';
}

function normalizePriority(value: string): string {
  return ['\u9ad8', '\u4e2d', '\u4f4e'].includes(value) ? value : '\u4e2d';
}

function nextWorkDate(base: Date, offset: number, avoidWeekends: boolean): Date {
  let date = addDays(base, offset);
  while (avoidWeekends && (date.getDay() === 0 || date.getDay() === 6)) {
    date = addDays(date, 1);
  }
  return date;
}

function nextScheduleDate(base: Date, avoidWeekends: boolean): Date {
  return nextWorkDate(base, 1, avoidWeekends);
}

function buildFallbackSubtasks(taskName: string, totalMinutes: number, preference: UserPreferenceLike): ParsedSubtask[] {
  const count = clamp(Math.ceil(totalMinutes / Math.max(30, preference.dailyFocusLimitMinutes)), 3, 6);
  const baseMinutes = Math.floor(totalMinutes / count);

  return Array.from({ length: count }, (_, index) => ({
    title: `${taskName} ${index + 1}`,
    minutes: index === count - 1 ? totalMinutes - baseMinutes * index : baseMinutes,
    order: index + 1
  }));
}

function buildFallbackParsedTask(input: string, preference: UserPreferenceLike): ParsedScheduleTask {
  const totalMinutes = extractTotalMinutes(input);
  const taskName = extractTaskName(input);
  const deadline = addDays(new Date(), 5);
  deadline.setHours(23, 59, 0, 0);

  return {
    taskName,
    deadline: deadline.toISOString(),
    totalMinutes,
    priority: '\u4e2d',
    constraints: {
      avoidWeekends: preference.avoidWeekends,
      preferredTimeOfDay: 'any',
      preferredStartTime: preference.preferredStartTime,
      preferredEndTime: preference.preferredEndTime
    },
    subtasks: buildFallbackSubtasks(taskName, totalMinutes, preference)
  };
}

async function getPreference(userId: string): Promise<UserPreferenceLike> {
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

async function parseTask(input: string, preference: UserPreferenceLike): Promise<ParsedScheduleTask> {
  try {
    return await parseTaskWithDeepSeek(input, {
      nowIso: new Date().toISOString(),
      timezone: preference.timezone,
      preferredStartTime: preference.preferredStartTime,
      preferredEndTime: preference.preferredEndTime,
      dailyFocusLimitMinutes: preference.dailyFocusLimitMinutes,
      avoidWeekends: preference.avoidWeekends
    });
  } catch (error) {
    console.warn('[Agent] DeepSeek parse failed, using local fallback:', error instanceof Error ? error.message : error);
    return buildFallbackParsedTask(input, preference);
  }
}

function normalizeSubtasks(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): ParsedSubtask[] {
  const source = parsedTask.subtasks.length > 0 ? parsedTask.subtasks : buildFallbackSubtasks(parsedTask.taskName, parsedTask.totalMinutes, preference);
  const count = clamp(source.length, 3, 6);

  if (source.length >= 3) {
    return source.slice(0, count).map((subtask, index) => ({
      ...subtask,
      title: subtask.title || `${parsedTask.taskName} ${index + 1}`,
      minutes: Math.max(1, Math.round(Number(subtask.minutes || parsedTask.totalMinutes / count))),
      order: index + 1
    }));
  }

  return buildFallbackSubtasks(parsedTask.taskName, parsedTask.totalMinutes, preference);
}

function dateFromMaybeIso(value: string | undefined): Date | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value);
}

function scheduleSubtasks(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): ParsedSubtask[] {
  const subtasks = normalizeSubtasks(parsedTask, preference);
  const preferredStart = parseClock(parsedTask.constraints.preferredStartTime || preference.preferredStartTime);
  const preferredEnd = parseClock(parsedTask.constraints.preferredEndTime || preference.preferredEndTime);
  const windowMinutes = Math.max(30, preferredEnd - preferredStart);
  const avoidWeekends = Boolean(parsedTask.constraints.avoidWeekends ?? preference.avoidWeekends);
  let currentDate = nextScheduleDate(new Date(), avoidWeekends);
  let usedMinutesToday = 0;

  return subtasks.map((subtask) => {
    const existingStart = dateFromMaybeIso(subtask.startAt);
    const existingEnd = dateFromMaybeIso(subtask.endAt);
    if (existingStart && existingEnd) {
      return {
        ...subtask,
        startAt: formatLocalIso(existingStart),
        endAt: formatLocalIso(existingEnd)
      };
    }

    const duration = Math.max(1, subtask.minutes);
    if (usedMinutesToday + duration > windowMinutes || usedMinutesToday + duration > preference.dailyFocusLimitMinutes) {
      currentDate = nextScheduleDate(currentDate, avoidWeekends);
      usedMinutesToday = 0;
    }

    const startMinute = preferredStart + usedMinutesToday;
    const endMinute = startMinute + duration;
    usedMinutesToday += duration;

    const startAt = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), Math.floor(startMinute / 60), startMinute % 60, 0);
    const endAt = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), Math.floor(endMinute / 60), endMinute % 60, 0);

    return {
      ...subtask,
      startAt: formatLocalIso(startAt),
      endAt: formatLocalIso(endAt)
    };
  });
}

function ensureScheduleShape(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): ParsedScheduleTask {
  return {
    ...parsedTask,
    priority: normalizePriority(parsedTask.priority),
    constraints: {
      avoidWeekends: parsedTask.constraints.avoidWeekends ?? preference.avoidWeekends,
      preferredTimeOfDay: parsedTask.constraints.preferredTimeOfDay ?? 'any',
      preferredStartTime: parsedTask.constraints.preferredStartTime || preference.preferredStartTime,
      preferredEndTime: parsedTask.constraints.preferredEndTime || preference.preferredEndTime
    },
    subtasks: scheduleSubtasks(parsedTask, preference)
  };
}

function buildItems(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): PlanItem[] {
  const category = normalizeCategory(preference.defaultEventCategory);

  return parsedTask.subtasks.map((subtask, index) => {
    const start = dateFromMaybeIso(subtask.startAt) || new Date();
    const end = dateFromMaybeIso(subtask.endAt) || addDays(start, 0);

    return {
      id: `plan-item-${index + 1}`,
      title: subtask.title,
      date: formatDate(start),
      timeRange: `${formatClock(start.getHours() * 60 + start.getMinutes())} - ${formatClock(end.getHours() * 60 + end.getMinutes())}`,
      startAt: subtask.startAt,
      endAt: subtask.endAt,
      durationHours: Math.round((subtask.minutes / 60) * 10) / 10,
      category,
      priority: parsedTask.priority,
      evidence: subtask.evidence
    };
  });
}

function buildPlans(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): SchedulePlanOption[] {
  const items = buildItems(parsedTask, preference);
  const totalHours = Math.round((parsedTask.totalMinutes / 60) * 10) / 10;
  const variants = [
    { id: 'plan-balanced', name: 'Plan A', color: '#2563EB', accent: '#0891B2', summary: 'Balanced split using user preferences.' },
    { id: 'plan-focused', name: 'Plan B', color: '#16A34A', accent: '#0F766E', summary: 'Focused blocks with fewer context switches.' },
    { id: 'plan-buffered', name: 'Plan C', color: '#D97706', accent: '#BE123C', summary: 'Buffered schedule for safer deadlines.' }
  ];

  return variants.map((variant) => ({
    id: variant.id,
    name: variant.name,
    type: 'generated',
    color: variant.color,
    accent: variant.accent,
    taskName: parsedTask.taskName,
    deadline: parsedTask.deadline,
    totalHours,
    summary: variant.summary,
    reason: `${variant.summary} Deadline: ${parsedTask.deadline}. Preference window: ${preference.preferredStartTime}-${preference.preferredEndTime}.`,
    warnings: [],
    editableTextRegions: [
      {
        id: `${variant.id}-title`,
        planCardId: variant.id,
        path: 'taskName',
        text: parsedTask.taskName,
        kind: 'title'
      },
      {
        id: `${variant.id}-summary`,
        planCardId: variant.id,
        path: 'summary',
        text: variant.summary,
        kind: 'summary'
      },
      {
        id: `${variant.id}-reason`,
        planCardId: variant.id,
        path: 'reason',
        text: `${variant.summary} Deadline: ${parsedTask.deadline}. Preference window: ${preference.preferredStartTime}-${preference.preferredEndTime}.`,
        kind: 'reason'
      },
      ...items.map((item, index) => ({
        id: `${variant.id}-item-${index + 1}-title`,
        planCardId: variant.id,
        path: `items.${index}.title`,
        text: item.title,
        kind: 'block_title' as const
      }))
    ],
    items
  }));
}

function readScheduleStatus(scheduleToolResult: unknown): string {
  if (!scheduleToolResult || typeof scheduleToolResult !== 'object') return '';
  const status = (scheduleToolResult as { status?: unknown }).status;
  return typeof status === 'string' ? status : '';
}

function readToolStatus(toolResult: unknown): string {
  if (!toolResult || typeof toolResult !== 'object') return '';
  const status = (toolResult as { status?: unknown }).status;
  return typeof status === 'string' ? status : '';
}

function readToolErrors(toolResult: unknown): string[] {
  if (!toolResult || typeof toolResult !== 'object') return [];
  const errors = (toolResult as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors.map(String).filter(Boolean) : [];
}

function isParsedTaskFullyScheduledWithinDeadline(parsedTask: ParsedScheduleTask): boolean {
  const deadline = dateFromMaybeIso(parsedTask.deadline);
  if (!deadline || parsedTask.subtasks.length === 0) return false;
  return parsedTask.subtasks.every((subtask) => {
    const start = dateFromMaybeIso(subtask.startAt);
    const end = dateFromMaybeIso(subtask.endAt);
    return Boolean(start && end && end > start && end <= deadline);
  });
}

function canBuildFinalPlans(parsedTask: ParsedScheduleTask, scheduleToolResult: unknown): boolean {
  return readScheduleStatus(scheduleToolResult) === 'ready' && isParsedTaskFullyScheduledWithinDeadline(parsedTask);
}

function buildInputWithAgentContext(input: string, normalizedContext: unknown): string {
  if (!normalizedContext) return input;
  return [
    input,
    '',
    'Python agent normalized context:',
    JSON.stringify(normalizedContext)
  ].join('\n');
}

function readNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : undefined;
}

function readDraftAllocations(planResult: PythonPlanResult): Array<Record<string, unknown>> {
  const scheduleToolResult = planResult.scheduleToolResult;
  if (!scheduleToolResult || typeof scheduleToolResult !== 'object') return [];
  const draftAllocations = (scheduleToolResult as { draftAllocations?: unknown }).draftAllocations;
  return Array.isArray(draftAllocations) ? draftAllocations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function buildAllocationLookup(planResult: PythonPlanResult): Map<string, Record<string, unknown>[]> {
  const lookup = new Map<string, Record<string, unknown>[]>();
  for (const allocation of readDraftAllocations(planResult)) {
    const title = typeof allocation.title === 'string' ? allocation.title : '';
    const taskId = typeof allocation.taskId === 'string' ? allocation.taskId : '';
    for (const key of [title, taskId].filter(Boolean)) {
      const list = lookup.get(key) ?? [];
      list.push(allocation);
      lookup.set(key, list);
    }
  }
  return lookup;
}

function buildConflictsFromCheckResult(conflictCheckResult: unknown): Array<{ id: string; message: string }> {
  if (!conflictCheckResult || typeof conflictCheckResult !== 'object') return [];
  const conflicts = (conflictCheckResult as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item, index) => {
      const approvedByUser = Boolean(item.approvedByUser);
      const severity = typeof item.severity === 'string' ? item.severity : 'blocking';
      const prefix = approvedByUser || severity === 'info' ? '已确认冲突' : '时间冲突';
      const message = typeof item.message === 'string' && item.message.trim() ? item.message : '同一时间段内存在多个任务或日程';
      return {
        id: typeof item.id === 'string' && item.id.trim() ? item.id : `conflict-${index + 1}`,
        message: `${prefix}：${message}`
      };
    });
}

function buildParsedTaskFromAtomicPlan(input: string, normalizedContext: Record<string, unknown>, preference: UserPreferenceLike, planResult: PythonPlanResult): ParsedScheduleTask {
  const deadline = typeof normalizedContext.deadline === 'string' && !Number.isNaN(Date.parse(normalizedContext.deadline)) ? normalizedContext.deadline : new Date().toISOString();
  const totalMinutes = readNumber(normalizedContext.totalMinutes) || planResult.totalEstimatedMinutes || 120;
  const taskName = extractTaskName(input);
  const allocationLookup = buildAllocationLookup(planResult);

  return {
    taskName,
    deadline,
    totalMinutes,
    priority: '中',
    constraints: {
      avoidWeekends: preference.avoidWeekends,
      preferredTimeOfDay: 'any',
      preferredStartTime: preference.preferredStartTime,
      preferredEndTime: preference.preferredEndTime
    },
    subtasks: planResult.atomicTasks.map((task, index) => {
      const allocation = allocationLookup.get(task.title)?.shift();
      const startAt = typeof allocation?.startIso === 'string' ? allocation.startIso : undefined;
      const endAt = typeof allocation?.endIso === 'string' ? allocation.endIso : undefined;
      return {
        title: task.title,
        minutes: Math.max(1, Math.round(Number(task.plannedMinutes || allocation?.plannedMinutes || 30))),
        order: Number.isFinite(Number(task.order)) ? Math.round(Number(task.order)) : index + 1,
        durationRangeMinutes: task.durationRangeMinutes,
        dependsOn: task.dependsOn,
        evidence: task.evidence,
        startAt,
        endAt
      };
    })
  };
}

async function convertFieldsWithLlm(input: string, preference: UserPreferenceLike, clarificationJson: unknown, nowIso: string): Promise<AgentFieldExtraction> {
  try {
    return await extractAgentFieldsWithDeepSeek(input, {
      nowIso,
      userPreference: preference,
      clarificationJson
    });
  } catch (error) {
    console.error('[Agent] LLM field conversion failed:', error instanceof Error ? error.message : error);
    throw error;
  }
}

async function emitEvent(onEvent: AgentMainFlowEventHandler | undefined, event: Parameters<AgentMainFlowEventHandler>[0]): Promise<void> {
  await onEvent?.(event);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitStepStarted(onEvent: AgentMainFlowEventHandler | undefined, stepId: string, message: string): Promise<void> {
  await emitEvent(onEvent, { type: 'stepStarted', stepId, message });
  await sleep(320);
}

function collectResearchSourcesFromToolResults(toolResults: unknown): unknown[] {
  const results = Array.isArray(toolResults) ? toolResults : [];
  return results
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .flatMap((item) => {
      const query = typeof item.query === 'string' ? item.query : '';
      const provider = typeof item.provider === 'string' ? item.provider : '';
      const sourceResults = Array.isArray(item.results) ? item.results : [];
      return sourceResults
        .filter((source): source is Record<string, unknown> => Boolean(source) && typeof source === 'object')
        .map((source) => ({
          title: typeof source.title === 'string' ? source.title : '',
          url: typeof source.url === 'string' ? source.url : '',
          snippet: typeof source.snippet === 'string' ? source.snippet : '',
          query,
          provider,
          tool: typeof item.tool === 'string' ? item.tool : 'web_search'
        }));
    })
    .slice(0, 8);
}

export async function runScheduleAgent({ userId, input, clarificationJson, onEvent }: RunScheduleAgentInput): Promise<AgentRunResponse | AgentClarificationResponse> {
  const preference = await getPreference(userId);
  const nowIso = new Date().toISOString();

  await emitStepStarted(onEvent, 'step-1', '正在解析用户输入并校验必填信息');
  const llmExtraction = await convertFieldsWithLlm(input, preference, clarificationJson, nowIso);

  const validation = await validateAgentFieldsWithPython({
    userId,
    rawInput: input,
    userPreference: preference,
    llmExtraction,
    clarificationJson
  });

  if (validation.status === 'needsUserInput') {
    const response: AgentClarificationResponse = {
      runId: `run-${Date.now()}`,
      status: 'needsUserInput',
      rawInput: input,
      message: validation.message,
      reasons: validation.reasons,
      clarificationJson: validation.clarificationJson
    };
    await emitEvent(onEvent, {
      type: 'stepUpdated',
      stepId: 'step-1',
      output: { message: validation.message, reasons: validation.reasons }
    });
    return response;
  }

  const normalizedContext = validation.normalizedContext;
  await emitEvent(onEvent, { type: 'stepSucceeded', stepId: 'step-1', output: { message: '用户输入已解析' } });
  await emitStepStarted(onEvent, 'step-2', '正在拆解子任务并查询外部资料');
  const enrichedInput = buildInputWithAgentContext(input, normalizedContext);
  const atomicPlan = await planAtomicTasksWithPython({
    userId,
    rawInput: input,
    userPreference: preference,
    normalizedContext
  });
  if (atomicPlan.status === 'failed') {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-2',
      output: { message: `Python Agent 工具规划失败：${atomicPlan.feasibility.issues.join('；') || '请检查外部搜索工具配置'}` }
    });
    throw new Error(`Python Agent 工具规划失败：${atomicPlan.feasibility.issues.join('；') || '请检查外部搜索工具配置'}`);
  }
  if (atomicPlan.status === 'overloaded') {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-2',
      output: { message: `任务体量超过可用时长：${atomicPlan.feasibility.issues.join('；') || '请删减任务、增加可用时间或延后截止日期'}` }
    });
    throw new Error(`任务体量超过可用时长：${atomicPlan.feasibility.issues.join('；') || '请删减任务、增加可用时间或延后截止日期'}`);
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-2',
    output: {
      message: '子任务拆解完成，已查询外部资料来源',
      researchSources: collectResearchSourcesFromToolResults(atomicPlan.toolResults),
      researchToolResults: atomicPlan.toolResults
    }
  });
  const runId = `run-${Date.now()}`;
  const parsedTaskFromPython = buildParsedTaskFromAtomicPlan(input, normalizedContext, preference, atomicPlan);

  await emitStepStarted(onEvent, 'step-3', '正在查询用户本地日程');
  const calendarEventErrors = readToolErrors(atomicPlan.calendarEventsToolResult);
  if (calendarEventErrors.length > 0) {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-3',
      output: {
        message: `查询用户本地日程失败：${calendarEventErrors.join('；')}`,
        calendarEventsResult: atomicPlan.calendarEventsToolResult
      }
    });
    throw new Error(`查询用户本地日程失败：${calendarEventErrors.join('；')}`);
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-3',
    output: { message: '已查询用户本地日程', calendarEventsResult: atomicPlan.calendarEventsToolResult }
  });

  await emitStepStarted(onEvent, 'step-4', '正在计算本地空闲时间');
  const freeWindowErrors = readToolErrors(atomicPlan.freeWindowsToolResult);
  if (freeWindowErrors.length > 0) {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-4',
      output: {
        message: `计算本地空闲时间失败：${freeWindowErrors.join('；')}`,
        freeWindowsResult: atomicPlan.freeWindowsToolResult
      }
    });
    throw new Error(`计算本地空闲时间失败：${freeWindowErrors.join('；')}`);
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-4',
    output: { message: '已根据本地日程和用户偏好计算空闲时间', freeWindowsResult: atomicPlan.freeWindowsToolResult }
  });

  await emitStepStarted(onEvent, 'step-5', '正在生成排期草稿方案');
  const scheduleStatus = readScheduleStatus(atomicPlan.scheduleToolResult);
  const scheduleErrors = readToolErrors(atomicPlan.scheduleToolResult);
  if (scheduleErrors.length > 0 && scheduleStatus !== 'needsDecision') {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-5',
      output: {
        message: `排期工具执行失败：${scheduleErrors.join('；')}`,
        scheduleToolResult: atomicPlan.scheduleToolResult
      }
    });
    throw new Error(`排期工具执行失败：${scheduleErrors.join('；')}`);
  }
  if (scheduleStatus === 'needsDecision' || scheduleStatus === 'pending') {
    await savePlanningSession(runId, {
      userId,
      rawInput: input,
      userPreference: preference,
      normalizedContext,
      atomicPlan
    });
    await emitEvent(onEvent, {
      type: 'stepUpdated',
      stepId: 'step-5',
      output: {
        message: scheduleStatus === 'needsDecision' ? '排期工具需要用户决策后才能继续' : '排期工具仍在等待结果',
        scheduleToolResult: atomicPlan.scheduleToolResult
      }
    });
    return {
      runId,
      status: 'waitingConfirm',
      rawInput: enrichedInput,
      userPreference: preference,
      parsedTask: parsedTaskFromPython,
      plans: [],
      plan: undefined,
      conflicts: [],
      calendarEventsToolResult: atomicPlan.calendarEventsToolResult,
      freeWindowsToolResult: atomicPlan.freeWindowsToolResult,
      scheduleToolResult: atomicPlan.scheduleToolResult
    };
  }
  if (scheduleStatus !== 'ready') {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-5',
      output: {
        message: `排期工具返回了无法继续的状态：${scheduleStatus || 'unknown'}`,
        scheduleToolResult: atomicPlan.scheduleToolResult
      }
    });
    throw new Error(`排期工具返回了无法继续的状态：${scheduleStatus || 'unknown'}`);
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-5',
    output: { message: '已调用 Python 排期工具生成草稿方案', scheduleToolResult: atomicPlan.scheduleToolResult }
  });

  await emitStepStarted(onEvent, 'step-6', '正在检测时间冲突');
  const conflictErrors = readToolErrors(atomicPlan.conflictCheckResult);
  const conflictStatus = readToolStatus(atomicPlan.conflictCheckResult);
  if (conflictErrors.length > 0) {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-6',
      output: {
        message: `冲突检测失败：${conflictErrors.join('；')}`,
        conflictCheckResult: atomicPlan.conflictCheckResult
      }
    });
    throw new Error(`冲突检测失败：${conflictErrors.join('；')}`);
  }
  if (conflictStatus === 'needsDecision' || conflictStatus === 'pending') {
    const conflicts = buildConflictsFromCheckResult(atomicPlan.conflictCheckResult);
    await savePlanningSession(runId, {
      userId,
      rawInput: input,
      userPreference: preference,
      normalizedContext,
      atomicPlan
    });
    await emitEvent(onEvent, {
      type: 'stepUpdated',
      stepId: 'step-6',
      output: {
        message: conflictStatus === 'needsDecision' ? '检测到未确认冲突，需要处理后才能继续' : '冲突检测仍在等待结果',
        conflictCheckResult: atomicPlan.conflictCheckResult
      }
    });
    return {
      runId,
      status: 'waitingConfirm',
      rawInput: enrichedInput,
      userPreference: preference,
      parsedTask: parsedTaskFromPython,
      plans: [],
      plan: undefined,
      conflicts,
      calendarEventsToolResult: atomicPlan.calendarEventsToolResult,
      freeWindowsToolResult: atomicPlan.freeWindowsToolResult,
      scheduleToolResult: atomicPlan.scheduleToolResult,
      conflictCheckResult: atomicPlan.conflictCheckResult
    };
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-6',
    output: {
      message: buildConflictsFromCheckResult(atomicPlan.conflictCheckResult).length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突',
      conflictCheckResult: atomicPlan.conflictCheckResult
    }
  });
  const canShowFinalPlans = canBuildFinalPlans(parsedTaskFromPython, atomicPlan.scheduleToolResult);
  const parsedTask = canShowFinalPlans ? ensureScheduleShape(parsedTaskFromPython, preference) : parsedTaskFromPython;
  const pythonAgentAck = canShowFinalPlans
    ? await sendTaskToPythonAgent({
        userId,
        rawInput: enrichedInput,
        userPreference: preference,
        normalizedContext,
        parsedTask
      })
    : undefined;
  const plans = canShowFinalPlans ? buildPlans(parsedTask, preference) : [];
  const conflicts = buildConflictsFromCheckResult(atomicPlan.conflictCheckResult);

  await savePlanningSession(runId, {
    userId,
    rawInput: input,
    userPreference: preference,
    normalizedContext,
    atomicPlan
  });

  await emitStepStarted(onEvent, 'step-7', '正在准备前端方案卡');
  if (plans.length === 0) {
    await emitEvent(onEvent, {
      type: 'stepUpdated',
      stepId: 'step-7',
      output: { runId, status: '等待用户确认排期处理方式' }
    });
    return {
      runId,
      status: 'waitingConfirm',
      rawInput: enrichedInput,
      userPreference: preference,
      parsedTask,
      pythonAgentAck,
      plans,
      plan: undefined,
      conflicts,
      calendarEventsToolResult: atomicPlan.calendarEventsToolResult,
      freeWindowsToolResult: atomicPlan.freeWindowsToolResult,
      scheduleToolResult: atomicPlan.scheduleToolResult,
      conflictCheckResult: atomicPlan.conflictCheckResult
    };
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-7',
    output: { runId, status: '等待用户选择方案' }
  });

  return {
    runId,
    status: 'waitingConfirm',
    rawInput: enrichedInput,
    userPreference: preference,
    parsedTask,
    pythonAgentAck,
    plans,
    plan: plans[0],
    conflicts,
    calendarEventsToolResult: atomicPlan.calendarEventsToolResult,
    freeWindowsToolResult: atomicPlan.freeWindowsToolResult,
    scheduleToolResult: atomicPlan.scheduleToolResult,
    conflictCheckResult: atomicPlan.conflictCheckResult
  };
}

export async function resumeScheduleDecision(
  userId: string,
  runId: string,
  decision: { optionId: string; taskId: string }
): Promise<AgentDecisionResponse> {
  const session = await findPlanningSession(runId, userId);
  if (!session || session.userId !== userId) {
    throw new Error('找不到当前 Agent 规划会话，可能服务重启或会话已过期，请重新生成方案');
    throw new Error('找不到当前 Agent 规划会话，请重新生成方案');
  }

  const resumeResult = await resumeScheduleWithPython({
    decision,
    planningState: {
      rawInput: session.rawInput,
      normalizedContext: session.normalizedContext,
      userPreference: session.userPreference,
      atomicTasks: session.atomicPlan.atomicTasks,
      toolResults: session.atomicPlan.toolResults,
      calendarEventsToolResult: session.atomicPlan.calendarEventsToolResult,
      freeWindowsToolResult: session.atomicPlan.freeWindowsToolResult,
      scheduleToolResult: session.atomicPlan.scheduleToolResult
    }
  });

  if (resumeResult.status !== 'ready') {
    throw new Error(resumeResult.message || resumeResult.issues?.join('；') || 'Agent 决策恢复失败');
    throw new Error(resumeResult.message || resumeResult.issues?.join('；') || 'Agent 决策恢复失败');
  }

  const nextAtomicPlan: PythonPlanResult = {
    ...session.atomicPlan,
    atomicTasks: resumeResult.atomicTasks,
    totalEstimatedMinutes: resumeResult.atomicTasks.reduce((sum, task) => sum + Math.max(0, Math.round(Number(task.plannedMinutes || 0))), 0),
    toolResults: resumeResult.toolResults ?? session.atomicPlan.toolResults,
    scheduleToolResult: resumeResult.scheduleToolResult,
    conflictCheckResult: resumeResult.conflictCheckResult
  };
  await updatePlanningSessionAtomicPlan(runId, userId, nextAtomicPlan);

  const parsedTaskFromPython = buildParsedTaskFromAtomicPlan(session.rawInput, session.normalizedContext, session.userPreference, nextAtomicPlan);
  const canShowFinalPlans = canBuildFinalPlans(parsedTaskFromPython, resumeResult.scheduleToolResult);
  const parsedTask = canShowFinalPlans ? ensureScheduleShape(parsedTaskFromPython, session.userPreference) : parsedTaskFromPython;
  const plans = canShowFinalPlans ? buildPlans(parsedTask, session.userPreference) : [];
  const conflicts = buildConflictsFromCheckResult(resumeResult.conflictCheckResult);
  return {
    runId,
    status: 'waitingConfirm',
    plans,
    plan: plans[0],
    conflicts,
    scheduleToolResult: resumeResult.scheduleToolResult,
    conflictCheckResult: resumeResult.conflictCheckResult,
    splitResult: resumeResult.splitResult
  };
}

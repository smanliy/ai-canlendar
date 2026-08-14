import { prisma } from '../db/prisma';
import { parseTaskWithDeepSeek } from './deepseek';
import { extractAgentFieldsWithDeepSeek, type AgentFieldExtraction } from './field-extractor';
import { planAtomicTasksWithPython, sendTaskToPythonAgent, validateAgentFieldsWithPython, type PythonPlanResult } from './python-agent';
import type { AgentCreateRunResponse, AgentUserPreference, ParsedScheduleTask, ParsedSubtask, PlanItem, SchedulePlanOption } from './agent.types';

interface RunScheduleAgentInput {
  userId: string;
  input: string;
  clarificationJson?: unknown;
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
    items
  }));
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

function buildParsedTaskFromAtomicPlan(input: string, normalizedContext: Record<string, unknown>, preference: UserPreferenceLike, planResult: PythonPlanResult): ParsedScheduleTask {
  const deadline = typeof normalizedContext.deadline === 'string' && !Number.isNaN(Date.parse(normalizedContext.deadline)) ? normalizedContext.deadline : new Date().toISOString();
  const totalMinutes = readNumber(normalizedContext.totalMinutes) || planResult.totalEstimatedMinutes || 120;
  const taskName = extractTaskName(input);

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
    subtasks: planResult.atomicTasks.map((task, index) => ({
      title: task.title,
      minutes: Math.max(1, Math.round(Number(task.plannedMinutes || 30))),
      order: Number.isFinite(Number(task.order)) ? Math.round(Number(task.order)) : index + 1,
      durationRangeMinutes: task.durationRangeMinutes,
      dependsOn: task.dependsOn,
      evidence: task.evidence
    }))
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

export async function runScheduleAgent({ userId, input, clarificationJson }: RunScheduleAgentInput): Promise<AgentCreateRunResponse> {
  const preference = await getPreference(userId);
  const nowIso = new Date().toISOString();

  const llmExtraction = await convertFieldsWithLlm(input, preference, clarificationJson, nowIso);

  const validation = await validateAgentFieldsWithPython({
    userId,
    rawInput: input,
    userPreference: preference,
    llmExtraction,
    clarificationJson
  });

  if (validation.status === 'needsUserInput') {
    return {
      runId: `run-${Date.now()}`,
      status: 'needsUserInput',
      rawInput: input,
      message: validation.message,
      reasons: validation.reasons,
      clarificationJson: validation.clarificationJson
    };
  }

  const normalizedContext = validation.normalizedContext;
  const enrichedInput = buildInputWithAgentContext(input, normalizedContext);
  const atomicPlan = await planAtomicTasksWithPython({
    userId,
    rawInput: input,
    userPreference: preference,
    normalizedContext
  });
  if (atomicPlan.status === 'failed') {
    throw new Error(`Python Agent 工具规划失败：${atomicPlan.feasibility.issues.join('；') || '请检查外部搜索工具配置'}`);
  }
  if (atomicPlan.status === 'overloaded') {
    throw new Error(`任务体量超过可用时长：${atomicPlan.feasibility.issues.join('；') || '请删减任务、增加可用时间或延后截止日期'}`);
  }
  const parsedTask = ensureScheduleShape(buildParsedTaskFromAtomicPlan(input, normalizedContext, preference, atomicPlan), preference);
  const pythonAgentAck = await sendTaskToPythonAgent({
    userId,
    rawInput: enrichedInput,
    userPreference: preference,
    normalizedContext,
    parsedTask
  });
  const plans = buildPlans(parsedTask, preference);

  return {
    runId: `run-${Date.now()}`,
    status: 'waitingConfirm',
    rawInput: enrichedInput,
    userPreference: preference,
    parsedTask,
    pythonAgentAck,
    plans,
    plan: plans[0],
    conflicts: [],
    calendarEventsToolResult: atomicPlan.calendarEventsToolResult
  };
}

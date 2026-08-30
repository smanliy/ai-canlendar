import { prisma } from '../db/prisma';
import * as eventService from '../events/events.service';
import type { EventPayload } from '../events/events.schema';
import { parseTaskWithDeepSeek } from './deepseek';
import { extractAgentFieldsWithDeepSeek, type AgentFieldExtraction, type TokenUsageSummary } from './field-extractor';
import { planAtomicTasksWithPython, resumeScheduleWithPython, sendTaskToPythonAgent, validateAgentFieldsWithPython, type PythonPlanResult } from './python-agent';
import type { AgentAnnotationResponse, AgentAutoCreatedResponse, AgentClarificationResponse, AgentConflict, AgentDecisionResponse, AgentRunResponse, AgentUserPreference, ParsedScheduleTask, ParsedSubtask, PlanItem, SchedulePlanOption } from './agent.types';
import type { AgentMainFlowEventHandler } from './agent-main-flow';
import { findPlanningSession, savePlanningSession, updatePlanningSessionAtomicPlan } from './agent-planning-session.repository';

interface RunScheduleAgentInput {
  userId: string;
  input: string;
  clarificationJson?: unknown;
  onEvent?: AgentMainFlowEventHandler;
}

type UserPreferenceLike = AgentUserPreference;

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

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
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      phone: `bridge-${userId}`,
      nickname: 'OpenClaw Bridge',
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

function minutesBetween(start: Date, end: Date): number {
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
}

function buildFocusedBlocks(tasks: ParsedSubtask[]): ParsedSubtask[] {
  if (tasks.length <= 2) return tasks;

  const groupCount = tasks.length >= 5 ? 3 : 2;
  const groups: ParsedSubtask[][] = Array.from({ length: groupCount }, () => []);
  tasks.forEach((task, index) => {
    groups[Math.floor((index * groupCount) / tasks.length)].push(task);
  });

  return groups
    .filter((group) => group.length > 0)
    .map((group, index) => {
      const titles = group.map((task) => task.title).filter(Boolean);
      return {
        title: titles.length > 1 ? `集中学习：${titles.join(' / ')}` : titles[0] || `集中学习 ${index + 1}`,
        minutes: group.reduce((sum, task) => sum + Math.max(1, task.minutes), 0),
        order: index + 1,
        durationRangeMinutes: [
          group.reduce((sum, task) => sum + Math.max(1, task.durationRangeMinutes?.[0] ?? task.minutes), 0),
          group.reduce((sum, task) => sum + Math.max(1, task.durationRangeMinutes?.[1] ?? task.minutes), 0)
        ],
        dependsOn: Array.from(new Set(group.flatMap((task) => task.dependsOn ?? []))),
        evidence: group.flatMap((task) => task.evidence ?? []).slice(0, 4)
      };
    });
}

function scheduleSubtasksForVariant(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike, variantId: string): ParsedSubtask[] {
  if (variantId === 'plan-balanced') return parsedTask.subtasks;

  const baseStart = parsedTask.subtasks.map((task) => dateFromMaybeIso(task.startAt)).find(Boolean) ?? nextScheduleDate(new Date(), preference.avoidWeekends);
  const avoidWeekends = parsedTask.constraints.avoidWeekends ?? preference.avoidWeekends;
  const preferredStart = parseClock(parsedTask.constraints.preferredStartTime || preference.preferredStartTime);
  const preferredEnd = parseClock(parsedTask.constraints.preferredEndTime || preference.preferredEndTime);
  const windowMinutes = Math.max(60, preferredEnd - preferredStart);
  const sourceTasks = parsedTask.subtasks.map((task) => ({ ...task }));

  if (variantId === 'plan-focused') {
    const focusedBlocks = buildFocusedBlocks(sourceTasks);
    const focusLimit = Math.max(windowMinutes, preference.dailyFocusLimitMinutes);
    let currentDate = new Date(baseStart);
    let usedMinutesToday = 0;

    return focusedBlocks.map((task, index) => {
      const duration = Math.max(1, task.minutes);
      if (usedMinutesToday + duration > focusLimit || usedMinutesToday + duration > windowMinutes) {
        currentDate = nextScheduleDate(currentDate, avoidWeekends);
        usedMinutesToday = 0;
      }
      const startMinute = preferredStart + usedMinutesToday;
      const startAt = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), Math.floor(startMinute / 60), startMinute % 60, 0);
      const endAt = new Date(startAt.getTime() + duration * 60000);
      usedMinutesToday += duration;
      return {
        ...task,
        order: index + 1,
        startAt: formatLocalIso(startAt),
        endAt: formatLocalIso(endAt)
      };
    });
  }

  const deadline = dateFromMaybeIso(parsedTask.deadline);
  const reversed = [...sourceTasks].reverse();
  let currentEnd = deadline ? new Date(deadline) : addDays(baseStart, 2);
  currentEnd = new Date(currentEnd.getTime() - 6 * 60 * 60000);
  currentEnd.setMinutes(Math.min(currentEnd.getMinutes(), 0), 0, 0);
  if (currentEnd.getHours() > Math.floor(preferredEnd / 60)) {
    currentEnd.setHours(Math.floor(preferredEnd / 60), preferredEnd % 60, 0, 0);
  }

  const scheduled = reversed.map((task) => {
    const duration = Math.max(1, task.minutes);
    let endAt = new Date(currentEnd);
    let startAt = new Date(endAt.getTime() - duration * 60000);
    const dayStart = new Date(endAt);
    dayStart.setHours(Math.floor(preferredStart / 60), preferredStart % 60, 0, 0);
    if (startAt < dayStart) {
      endAt = nextWorkDate(addDays(endAt, -1), 0, avoidWeekends);
      endAt.setHours(Math.floor(preferredEnd / 60), preferredEnd % 60, 0, 0);
      startAt = new Date(endAt.getTime() - duration * 60000);
    }
    currentEnd = new Date(startAt.getTime() - 15 * 60000);
    return {
      ...task,
      startAt: formatLocalIso(startAt),
      endAt: formatLocalIso(endAt)
    };
  });

  return scheduled.reverse().map((task, index) => ({
    ...task,
    order: index + 1,
    minutes: task.startAt && task.endAt ? minutesBetween(new Date(task.startAt), new Date(task.endAt)) : task.minutes
  }));
}

function buildPlans(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): SchedulePlanOption[] {
  const totalHours = Math.round((parsedTask.totalMinutes / 60) * 10) / 10;
  const variants = [
    { id: 'plan-balanced', name: 'Plan A', color: '#2563EB', accent: '#0891B2', summary: 'Balanced split using user preferences.' },
    { id: 'plan-focused', name: 'Plan B', color: '#16A34A', accent: '#0F766E', summary: 'Focused blocks with fewer context switches.' }
    // { id: 'plan-buffered', name: 'Plan C', color: '#D97706', accent: '#BE123C', summary: 'Buffered schedule for safer deadlines.' }
  ];

  return variants.map((variant) => {
    const variantTask = {
      ...parsedTask,
      subtasks: scheduleSubtasksForVariant(parsedTask, preference, variant.id)
    };
    const items = buildItems(variantTask, preference);
    const reason = `${variant.summary} Deadline: ${parsedTask.deadline}. Preference window: ${preference.preferredStartTime}-${preference.preferredEndTime}.`;
    return {
      id: variant.id,
      name: variant.name,
      type: 'generated',
      color: variant.color,
      accent: variant.accent,
      taskName: parsedTask.taskName,
      deadline: parsedTask.deadline,
      totalHours,
      summary: variant.summary,
      reason,
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
          text: reason,
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
    };
  });
}

function planItemToEventPayload(item: PlanItem, runId: string): EventPayload {
  const [start, end] = item.timeRange.split(' - ');
  return {
    title: item.title,
    startTime: item.startAt ?? `${item.date}T${start}:00+08:00`,
    endTime: item.endAt ?? `${item.date}T${end}:00+08:00`,
    category: normalizeCategory(item.category) as EventPayload['category'],
    priority: normalizePriority(item.priority) as EventPayload['priority'],
    status: '未开始',
    note: `由 Agent Run ${runId} 自动写入`
  };
}

function shouldAutoCreateCalendarEvents(atomicPlan: PythonPlanResult, plans: SchedulePlanOption[], conflicts: AgentConflict[]): boolean {
  return atomicPlan.atomicTasks.length === 1 && plans.length > 0 && conflicts.length === 0;
}

function readEditablePlanText(plan: SchedulePlanOption, path: string): string {
  if (path === 'name') return plan.name;
  if (path === 'taskName') return plan.taskName;
  if (path === 'summary') return plan.summary ?? '';
  if (path === 'reason') return plan.reason ?? '';

  const itemTitleMatch = /^items\.(\d+)\.title$/.exec(path);
  if (itemTitleMatch) {
    const item = plan.items[Number(itemTitleMatch[1])];
    return item?.title ?? '';
  }

  throw new Error(`不支持批注修改字段：${path}`);
}

function writeEditablePlanText(plan: SchedulePlanOption, path: string, value: string): void {
  if (path === 'name') {
    plan.name = value;
  } else if (path === 'taskName') {
    plan.taskName = value;
  } else if (path === 'summary') {
    plan.summary = value;
  } else if (path === 'reason') {
    plan.reason = value;
  } else {
    const itemTitleMatch = /^items\.(\d+)\.title$/.exec(path);
    if (!itemTitleMatch) {
      throw new Error(`不支持批注修改字段：${path}`);
    }
    const item = plan.items[Number(itemTitleMatch[1])];
    if (!item) {
      throw new Error(`找不到批注对应的任务项：${path}`);
    }
    item.title = value;
  }

  plan.editableTextRegions = plan.editableTextRegions?.map((region) =>
    region.path === path
      ? {
          ...region,
          text: value
        }
      : region
  );
}

function applyPlanTextOverrides(plans: SchedulePlanOption[], overrides: unknown): SchedulePlanOption[] {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return plans;

  return plans.map((plan) => {
    const planOverrides = (overrides as Record<string, unknown>)[plan.id];
    if (!planOverrides || typeof planOverrides !== 'object' || Array.isArray(planOverrides)) return plan;

    const nextPlan = JSON.parse(JSON.stringify(plan)) as SchedulePlanOption;
    for (const [path, text] of Object.entries(planOverrides as Record<string, unknown>)) {
      if (typeof text === 'string' && text.trim()) {
        writeEditablePlanText(nextPlan, path, text.trim());
      }
    }
    return nextPlan;
  });
}

function applyPlanOverrides(plans: SchedulePlanOption[], overrides: unknown): SchedulePlanOption[] {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return plans;

  return plans.map((plan) => {
    const override = (overrides as Record<string, unknown>)[plan.id];
    if (!override || typeof override !== 'object' || Array.isArray(override)) return plan;
    return {
      ...plan,
      ...(override as Partial<SchedulePlanOption>),
      id: plan.id,
      type: 'generated',
      color: plan.color,
      accent: plan.accent
    };
  });
}

function applyAllPlanOverrides(plans: SchedulePlanOption[], planResult: PythonPlanResult): SchedulePlanOption[] {
  return applyPlanTextOverrides(applyPlanOverrides(plans, planResult.planOverrides), planResult.planTextOverrides);
}

function normalizeAnnotationPath(path: string | undefined, kind: string | undefined): string {
  const value = path?.trim();
  if (value) return value;
  if (kind === 'summary') return 'summary';
  if (kind === 'reason') return 'reason';
  if (kind === 'title') return 'name';
  throw new Error('批注缺少可定位的 path');
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。；：、,.!！?？"'“”‘’`]/g, '').trim();
}

function selectedTextStillMatches(fieldText: string, selectedText: string): boolean {
  if (fieldText.includes(selectedText)) return true;
  const normalizedField = normalizeComparableText(fieldText);
  const normalizedSelection = normalizeComparableText(selectedText);
  return Boolean(normalizedSelection && normalizedField.includes(normalizedSelection));
}

function buildSelectionConsistencyWarning(fieldText: string, selectedText: string): string | undefined {
  return selectedTextStillMatches(fieldText, selectedText) ? undefined : '批注选中文本与当前字段不完全一致，已按字段 path 对整张方案重新生成。';
}

function buildCompactPlanForRevision(plan: SchedulePlanOption, selectedPath: string) {
  const selectedItemMatch = /^items\.(\d+)\./.exec(selectedPath);
  const selectedItemIndex = selectedItemMatch ? Number(selectedItemMatch[1]) : -1;

  return {
    id: plan.id,
    name: plan.name,
    taskName: plan.taskName,
    deadline: plan.deadline,
    totalHours: plan.totalHours,
    summary: plan.summary,
    reason: plan.reason,
    selectedItemIndex: selectedItemIndex >= 0 ? selectedItemIndex : null,
    selectedItem: selectedItemIndex >= 0 ? plan.items[selectedItemIndex] : null,
    items: plan.items.map((item, index) => ({
      index,
      id: item.id,
      title: item.title,
      date: item.date,
      timeRange: item.timeRange,
      durationHours: item.durationHours,
      startAt: item.startAt,
      endAt: item.endAt,
      category: item.category,
      priority: item.priority
    }))
  };
}

function normalizeRegeneratedPlan(basePlan: SchedulePlanOption, value: unknown): SchedulePlanOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DeepSeek plan revision returned invalid object');
  }
  const raw = value as Record<string, unknown>;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (rawItems.length === 0) {
    throw new Error('DeepSeek plan revision returned empty items');
  }

  const items = rawItems.map((item, index) => {
    const rawItem = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const fallbackItem = basePlan.items[index] ?? basePlan.items[basePlan.items.length - 1];
    const title = typeof rawItem.title === 'string' && rawItem.title.trim() ? rawItem.title.trim() : fallbackItem.title;
    const date = typeof rawItem.date === 'string' && rawItem.date.trim() ? rawItem.date.trim() : fallbackItem.date;
    const timeRange = typeof rawItem.timeRange === 'string' && rawItem.timeRange.trim() ? rawItem.timeRange.trim() : fallbackItem.timeRange;
    const durationHours = Number.isFinite(Number(rawItem.durationHours)) ? Number(rawItem.durationHours) : fallbackItem.durationHours;
    const evidence = title === fallbackItem.title ? fallbackItem.evidence : [];
    return {
      ...fallbackItem,
      id: fallbackItem.id ?? `plan-item-${index + 1}`,
      title,
      date,
      timeRange,
      durationHours,
      startAt: typeof rawItem.startAt === 'string' ? rawItem.startAt : fallbackItem.startAt,
      endAt: typeof rawItem.endAt === 'string' ? rawItem.endAt : fallbackItem.endAt,
      evidence
    };
  });

  const taskName = typeof raw.taskName === 'string' && raw.taskName.trim() ? raw.taskName.trim() : basePlan.taskName;
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : basePlan.summary;
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : basePlan.reason;

  return {
    ...basePlan,
    taskName,
    summary,
    reason,
    items,
    editableTextRegions: [
      {
        id: `${basePlan.id}-title`,
        planCardId: basePlan.id,
        path: 'taskName',
        text: taskName,
        kind: 'title'
      },
      {
        id: `${basePlan.id}-summary`,
        planCardId: basePlan.id,
        path: 'summary',
        text: summary ?? '',
        kind: 'summary'
      },
      {
        id: `${basePlan.id}-reason`,
        planCardId: basePlan.id,
        path: 'reason',
        text: reason ?? '',
        kind: 'reason'
      },
      ...items.map((item, index) => ({
        id: `${basePlan.id}-item-${index + 1}-title`,
        planCardId: basePlan.id,
        path: `items.${index}.title`,
        text: item.title,
        kind: 'block_title' as const
      }))
    ]
  };
}

function readDeepSeekTokenUsage(
  data: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } },
  model: string
): TokenUsageSummary | null {
  const promptTokens = Number(data.usage?.prompt_tokens);
  const completionTokens = Number(data.usage?.completion_tokens);
  const totalTokens = Number(data.usage?.total_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    model
  };
}

async function regeneratePlanWithDeepSeek(input: {
  basePlan: SchedulePlanOption;
  selectedText: string;
  comment: string;
  path: string;
  kind?: string;
  rawInput: string;
}): Promise<{ plan: SchedulePlanOption; llmUsage?: TokenUsageSummary }> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY，无法按批注重生成方案');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content:
              '你是日程方案局部重生成器。只修改用户批注的这一张方案卡，返回严格 JSON。不要输出 Markdown、解释或多余字段。不要编造新的 URL；如果任务语义变化，相关 evidence 交给系统清空。'
          },
          {
            role: 'user',
            content: [
              `原始用户需求：${input.rawInput}`,
              `批注字段路径：${input.path}`,
              input.kind ? `批注字段类型：${input.kind}` : '',
              `被选中文本：${input.selectedText}`,
              `用户批注：${input.comment}`,
              '当前方案精简 JSON：',
              JSON.stringify(buildCompactPlanForRevision(input.basePlan, input.path)),
              '',
              '请返回 JSON：{"taskName": string, "summary": string, "reason": string, "items": [{"title": string, "date": string, "timeRange": string, "durationHours": number, "startAt": string, "endAt": string}]}',
              '要求：保留这张方案的总体截止时间和总时长；围绕用户批注调整任务内容和必要的时间安排；不要改其他方案。'
            ]
              .filter(Boolean)
              .join('\n')
          }
        ],
        temperature: 0.25,
        max_tokens: 2600
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek plan revision failed: HTTP ${response.status} ${rawText}`);
    }
    const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
    const parsed = JSON.parse(rawText) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    const planJson = parseJsonObjectFromText(typeof content === 'string' ? content : '');
    return {
      plan: normalizeRegeneratedPlan(input.basePlan, planJson),
      llmUsage: readDeepSeekTokenUsage(parsed, model) ?? undefined
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('批注方案重生成请求 DeepSeek 超时，请稍后重试');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatDeepSeekText(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\s+/g, ' ').trim();
}

function parseJsonObjectFromText(raw: string): unknown {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('DeepSeek 没有返回可解析的方案 JSON，请重新提交批注');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function rewriteSelectedTextWithDeepSeek(input: {
  fullText: string;
  selectedText: string;
  comment: string;
  path: string;
  kind?: string;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY，无法按批注生成局部 patch');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content:
              '你是日程方案的局部文本编辑器。只根据用户批注改写被选中的文本片段，不改变日期、时间、时长、顺序，不输出解释、Markdown 或 JSON。'
          },
          {
            role: 'user',
            content: [
              `字段路径：${input.path}`,
              input.kind ? `字段类型：${input.kind}` : '',
              `字段完整原文：${input.fullText}`,
              `被选中文本：${input.selectedText}`,
              `用户批注：${input.comment}`,
              '请只输出“被选中文本”的替换文本。'
            ]
              .filter(Boolean)
              .join('\n')
          }
        ],
        temperature: 0.2,
        max_tokens: 180
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek annotation patch failed: HTTP ${response.status} ${rawText}`);
    }
    const data = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    const nextText = formatDeepSeekText(typeof content === 'string' ? content : '');
    if (!nextText) {
      throw new Error('DeepSeek annotation patch returned empty text');
    }
    return nextText;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('批注局部改写请求 DeepSeek 超时，请稍后重试');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

async function convertFieldsWithLlm(
  input: string,
  preference: UserPreferenceLike,
  clarificationJson: unknown,
  nowIso: string
): Promise<AgentFieldExtraction & { llmUsage?: TokenUsageSummary }> {
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

function readTaskShapeDecision(planResult: PythonPlanResult): string {
  const decision = planResult.taskShapeDecision?.decision;
  return typeof decision === 'string' ? decision : '';
}

function buildTaskShapeStepMessage(planResult: PythonPlanResult): string {
  if (readTaskShapeDecision(planResult) === 'atomic') {
    return 'LLM 判断无需拆分，已按单任务继续排期';
  }
  const researchSources = collectResearchSourcesFromToolResults(planResult.toolResults);
  if (researchSources.length > 0) {
    return 'LLM 判断需要拆分，已查询外部资料并生成原子任务';
  }
  return 'LLM 判断需要拆分，外部资料为空，已按单任务兜底继续排期';
}

export async function runScheduleAgent({ userId, input, clarificationJson, onEvent }: RunScheduleAgentInput): Promise<AgentRunResponse | AgentClarificationResponse | AgentAutoCreatedResponse> {
  const preference = await getPreference(userId);
  const nowIso = new Date().toISOString();
  const llmUsageByStep: NonNullable<AgentRunResponse['llmUsageByStep']> = {};

  await emitStepStarted(onEvent, 'step-1', '正在解析用户输入并校验必填信息');
  const llmExtraction = await convertFieldsWithLlm(input, preference, clarificationJson, nowIso);
  if (llmExtraction.llmUsage) {
    llmUsageByStep['step-1'] = llmExtraction.llmUsage;
  }

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
      clarificationJson: validation.clarificationJson,
      llmUsageByStep
    };
    await emitEvent(onEvent, {
      type: 'stepUpdated',
      stepId: 'step-1',
      output: {
        message: validation.message,
        reasons: validation.reasons,
        llmUsage: llmExtraction.llmUsage ?? null
      }
    });
    return response;
  }

  const normalizedContext = validation.normalizedContext;
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-1',
    output: {
      message: '用户输入已解析',
      llmUsage: llmExtraction.llmUsage ?? null
    }
  });
  await emitStepStarted(onEvent, 'step-2', '正在判断是否需要拆分任务');
  const enrichedInput = buildInputWithAgentContext(input, normalizedContext);
  const atomicPlan = await planAtomicTasksWithPython({
    userId,
    rawInput: input,
    userPreference: preference,
    normalizedContext
  });
  if (atomicPlan.llmUsage) {
    llmUsageByStep['step-2'] = atomicPlan.llmUsage;
  }
  if (atomicPlan.status === 'failed') {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-2',
      output: {
        message: `Python Agent 工具规划失败：${atomicPlan.feasibility.issues.join('；') || '请检查外部搜索工具配置'}`,
        llmUsage: atomicPlan.llmUsage ?? null
      }
    });
    throw new Error(`Python Agent 工具规划失败：${atomicPlan.feasibility.issues.join('；') || '请检查外部搜索工具配置'}`);
  }
  if (atomicPlan.status === 'overloaded') {
    await emitEvent(onEvent, {
      type: 'stepFailed',
      stepId: 'step-2',
      output: {
        message: `任务体量超过可用时长：${atomicPlan.feasibility.issues.join('；') || '请删减任务、增加可用时间或延后截止日期'}`,
        llmUsage: atomicPlan.llmUsage ?? null
      }
    });
    throw new Error(`任务体量超过可用时长：${atomicPlan.feasibility.issues.join('；') || '请删减任务、增加可用时间或延后截止日期'}`);
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-2',
    output: {
      message: buildTaskShapeStepMessage(atomicPlan),
      taskShapeDecision: atomicPlan.taskShapeDecision,
      researchSources: collectResearchSourcesFromToolResults(atomicPlan.toolResults),
      researchToolResults: atomicPlan.toolResults,
      agentTrace: atomicPlan.agentTrace,
      llmUsage: atomicPlan.llmUsage ?? null
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
        scheduleToolResult: atomicPlan.scheduleToolResult,
        agentTrace: atomicPlan.agentTrace
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
      scheduleToolResult: atomicPlan.scheduleToolResult,
      agentTrace: atomicPlan.agentTrace,
      llmUsageByStep
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
    output: { message: '已调用 Python 排期工具生成草稿方案', scheduleToolResult: atomicPlan.scheduleToolResult, agentTrace: atomicPlan.agentTrace }
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
        conflictCheckResult: atomicPlan.conflictCheckResult,
        agentTrace: atomicPlan.agentTrace
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
      conflictCheckResult: atomicPlan.conflictCheckResult,
      agentTrace: atomicPlan.agentTrace,
      llmUsageByStep
    };
  }
  await emitEvent(onEvent, {
    type: 'stepSucceeded',
    stepId: 'step-6',
    output: {
      message: buildConflictsFromCheckResult(atomicPlan.conflictCheckResult).length > 0 ? '检测到时间重叠冲突' : '未检测到时间重叠冲突',
      conflictCheckResult: atomicPlan.conflictCheckResult,
      agentTrace: atomicPlan.agentTrace
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
  const plans = canShowFinalPlans ? applyAllPlanOverrides(buildPlans(parsedTask, preference), atomicPlan) : [];
  const conflicts = buildConflictsFromCheckResult(atomicPlan.conflictCheckResult);

  if (shouldAutoCreateCalendarEvents(atomicPlan, plans, conflicts)) {
    const selectedPlan = plans[0];
    await emitStepStarted(onEvent, 'step-7', '任务无需拆分，已找到理想时间');
    await emitEvent(onEvent, {
      type: 'stepSucceeded',
      stepId: 'step-7',
      output: { runId, status: '无需选择方案，准备直接写入日历' }
    });
    await emitStepStarted(onEvent, 'step-8', '正在写入日历');
    const eventPayloads = selectedPlan.items.map((item) => planItemToEventPayload(item, runId));
    await eventService.bulkCreateEvents(userId, { events: eventPayloads, agentRunId: runId });
    await emitEvent(onEvent, {
      type: 'stepSucceeded',
      stepId: 'step-8',
      output: { created: eventPayloads.length }
    });
    return {
      runId,
      status: 'autoCreated',
      rawInput: enrichedInput,
      message: `已找到理想时间并写入日历，共创建 ${eventPayloads.length} 条日程。`,
      createdCount: eventPayloads.length,
      plan: selectedPlan,
      calendarEventsToolResult: atomicPlan.calendarEventsToolResult,
      freeWindowsToolResult: atomicPlan.freeWindowsToolResult,
      scheduleToolResult: atomicPlan.scheduleToolResult,
      conflictCheckResult: atomicPlan.conflictCheckResult,
      agentTrace: atomicPlan.agentTrace,
      llmUsageByStep
    };
  }

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
      conflictCheckResult: atomicPlan.conflictCheckResult,
      agentTrace: atomicPlan.agentTrace,
      llmUsageByStep
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
    conflictCheckResult: atomicPlan.conflictCheckResult,
    agentTrace: atomicPlan.agentTrace,
    llmUsageByStep
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
    conflictCheckResult: resumeResult.conflictCheckResult,
    agentTrace: resumeResult.agentTrace ?? session.atomicPlan.agentTrace
  };
  await updatePlanningSessionAtomicPlan(runId, userId, nextAtomicPlan);

  const parsedTaskFromPython = buildParsedTaskFromAtomicPlan(session.rawInput, session.normalizedContext, session.userPreference, nextAtomicPlan);
  const canShowFinalPlans = canBuildFinalPlans(parsedTaskFromPython, resumeResult.scheduleToolResult);
  const parsedTask = canShowFinalPlans ? ensureScheduleShape(parsedTaskFromPython, session.userPreference) : parsedTaskFromPython;
  const plans = canShowFinalPlans ? applyAllPlanOverrides(buildPlans(parsedTask, session.userPreference), nextAtomicPlan) : [];
  const conflicts = buildConflictsFromCheckResult(resumeResult.conflictCheckResult);
  return {
    runId,
    status: 'waitingConfirm',
    plans,
    plan: plans[0],
    conflicts,
    scheduleToolResult: resumeResult.scheduleToolResult,
    conflictCheckResult: resumeResult.conflictCheckResult,
    splitResult: resumeResult.splitResult,
    agentTrace: resumeResult.agentTrace,
    llmUsageByStep: resumeResult.llmUsage ? { 'resume-decision': resumeResult.llmUsage } : undefined
  };
}

export async function applyPlanAnnotation(
  userId: string,
  runId: string,
  annotation: {
    planCardId: string;
    regionId: string;
    selectedText: string;
    comment: string;
    path?: string;
    kind?: string;
  }
): Promise<AgentAnnotationResponse> {
  const session = await findPlanningSession(runId, userId);
  if (!session || session.userId !== userId) {
    throw new Error('找不到当前 Agent 规划会话，可能服务重启或会话已过期，请重新生成方案');
  }

  const parsedTaskFromPython = buildParsedTaskFromAtomicPlan(session.rawInput, session.normalizedContext, session.userPreference, session.atomicPlan);
  const canShowFinalPlans = canBuildFinalPlans(parsedTaskFromPython, session.atomicPlan.scheduleToolResult);
  if (!canShowFinalPlans) {
    throw new Error('当前排期还没有生成可批注的方案卡');
  }

  const parsedTask = ensureScheduleShape(parsedTaskFromPython, session.userPreference);
  const currentPlans = applyAllPlanOverrides(buildPlans(parsedTask, session.userPreference), session.atomicPlan);
  const targetPlan = currentPlans.find((plan) => plan.id === annotation.planCardId);
  if (!targetPlan) {
    throw new Error('找不到批注对应的方案卡');
  }

  const path = normalizeAnnotationPath(annotation.path, annotation.kind);
  const previousText = readEditablePlanText(targetPlan, path);
  if (!previousText) {
    throw new Error('批注对应字段为空，无法局部修改');
  }
  const consistencyWarning = buildSelectionConsistencyWarning(previousText, annotation.selectedText);

  const regenerated = await regeneratePlanWithDeepSeek({
    basePlan: targetPlan,
    rawInput: session.rawInput,
    selectedText: annotation.selectedText,
    comment: annotation.comment,
    path,
    kind: annotation.kind
  });

  const nextOverrides = {
    ...(session.atomicPlan.planOverrides ?? {}),
    [annotation.planCardId]: regenerated.plan
  };
  const nextAtomicPlan = {
    ...session.atomicPlan,
    planOverrides: nextOverrides,
    planTextOverrides: undefined
  };
  await updatePlanningSessionAtomicPlan(runId, userId, nextAtomicPlan);

  const nextPlans = applyAllPlanOverrides(buildPlans(parsedTask, session.userPreference), nextAtomicPlan);
  const conflicts = buildConflictsFromCheckResult(session.atomicPlan.conflictCheckResult);
  const selectedPlan = nextPlans.find((plan) => plan.id === annotation.planCardId) ?? nextPlans[0];

  return {
    runId,
    status: 'waitingConfirm',
    plans: nextPlans,
    plan: selectedPlan,
    conflicts,
    llmUsageByStep: regenerated.llmUsage ? { 'annotation-rewrite': regenerated.llmUsage } : undefined,
    annotation: {
      planCardId: annotation.planCardId,
      regionId: annotation.regionId,
      path,
      previousText,
      nextText: readEditablePlanText(selectedPlan, path),
      warning: consistencyWarning
    }
  };
}

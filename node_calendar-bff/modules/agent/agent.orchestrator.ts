import { prisma } from '../db/prisma';
import { parseTaskWithDeepSeek } from './deepseek';
import type { AgentRunResponse, ParsedScheduleTask, PlanItem, SchedulePlanOption } from './agent.types';

interface RunScheduleAgentInput {
  userId: string;
  input: string;
}

interface UserPreferenceLike {
  preferredStartTime: string;
  preferredEndTime: string;
  dailyFocusLimitMinutes: number;
  avoidWeekends: boolean;
  defaultEventCategory: string;
  timezone: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatClock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function extractTotalMinutes(input: string): number {
  const hourMatch = input.match(/(\d+(?:\.\d+)?)\s*(小时|h|H)/);
  if (hourMatch) return Math.max(30, Math.round(Number(hourMatch[1]) * 60));

  const minuteMatch = input.match(/(\d+)\s*(分钟|min)/i);
  if (minuteMatch) return Math.max(30, Math.round(Number(minuteMatch[1])));

  return 120;
}

function extractTaskName(input: string): string {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return 'Agent task';
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
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
    priority: '中',
    constraints: {
      avoidWeekends: preference.avoidWeekends,
      preferredTimeOfDay: 'any',
      preferredStartTime: preference.preferredStartTime,
      preferredEndTime: preference.preferredEndTime
    },
    subtasks: [
      {
        title: taskName,
        minutes: totalMinutes,
        order: 1
      }
    ]
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

function nextWorkDate(base: Date, offset: number, avoidWeekends: boolean): Date {
  let date = addDays(base, offset);
  while (avoidWeekends && (date.getDay() === 0 || date.getDay() === 6)) {
    date = addDays(date, 1);
  }
  return date;
}

function normalizeCategory(value: string): string {
  return ['工作', '学习', '生活', '面试'].includes(value) ? value : '学习';
}

function buildItems(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): PlanItem[] {
  const start = parseClock(parsedTask.constraints.preferredStartTime || preference.preferredStartTime);
  const end = parseClock(parsedTask.constraints.preferredEndTime || preference.preferredEndTime);
  const windowMinutes = Math.max(30, end - start);
  const dailyLimit = Math.max(30, preference.dailyFocusLimitMinutes);
  const blockMinutes = Math.min(windowMinutes, dailyLimit, parsedTask.totalMinutes);
  const category = normalizeCategory(preference.defaultEventCategory);

  const items: PlanItem[] = [];
  let remaining = parsedTask.totalMinutes;
  let dayOffset = 1;
  let order = 1;

  while (remaining > 0 && items.length < 14) {
    const duration = Math.min(blockMinutes, remaining);
    const date = nextWorkDate(new Date(), dayOffset, Boolean(parsedTask.constraints.avoidWeekends));
    const endTime = start + duration;

    items.push({
      id: `plan-item-${order}`,
      title: parsedTask.subtasks[order - 1]?.title || `${parsedTask.taskName} ${order}`,
      date: formatDate(date),
      timeRange: `${formatClock(start)} - ${formatClock(endTime)}`,
      durationHours: Math.round((duration / 60) * 10) / 10,
      category,
      priority: parsedTask.priority
    });

    remaining -= duration;
    dayOffset += 1;
    order += 1;
  }

  return items;
}

function buildPlans(parsedTask: ParsedScheduleTask, preference: UserPreferenceLike): SchedulePlanOption[] {
  const items = buildItems(parsedTask, preference);
  const totalHours = Math.round((parsedTask.totalMinutes / 60) * 10) / 10;

  return [
    {
      id: 'plan-balanced',
      name: '方案 A',
      type: 'generated',
      color: '#2563EB',
      accent: '#0891B2',
      taskName: parsedTask.taskName,
      deadline: parsedTask.deadline,
      totalHours,
      summary: `按你的偏好时间 ${preference.preferredStartTime}-${preference.preferredEndTime} 生成。`,
      items
    }
  ];
}

export async function runScheduleAgent({ userId, input }: RunScheduleAgentInput): Promise<AgentRunResponse> {
  const preference = await getPreference(userId);
  const parsedTask = await parseTask(input, preference);
  const plans = buildPlans(parsedTask, preference);

  return {
    runId: `run-${Date.now()}`,
    status: 'waitingConfirm',
    rawInput: input,
    parsedTask,
    plans,
    plan: plans[0],
    conflicts: []
  };
}

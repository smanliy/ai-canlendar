import type { ParsedScheduleTask } from './agent.types';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

interface ParseTaskContext {
  nowIso: string;
  timezone: string;
  preferredStartTime: string;
  preferredEndTime: string;
  dailyFocusLimitMinutes: number;
  avoidWeekends: boolean;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function normalizeParsedTask(value: unknown): ParsedScheduleTask {
  const task = value as Partial<ParsedScheduleTask>;
  if (!task || typeof task !== 'object') {
    throw new Error('DeepSeek output is not an object');
  }
  if (typeof task.taskName !== 'string' || !task.taskName.trim()) {
    throw new Error('DeepSeek output misses taskName');
  }
  if (typeof task.deadline !== 'string' || Number.isNaN(Date.parse(task.deadline))) {
    throw new Error('DeepSeek output misses valid deadline');
  }
  if (typeof task.totalMinutes !== 'number' || !Number.isFinite(task.totalMinutes) || task.totalMinutes <= 0) {
    throw new Error('DeepSeek output misses valid totalMinutes');
  }

  const subtasks = Array.isArray(task.subtasks) && task.subtasks.length > 0 ? task.subtasks : [{ title: task.taskName, minutes: task.totalMinutes, order: 1 }];

  return {
    taskName: task.taskName.trim(),
    deadline: new Date(task.deadline).toISOString(),
    totalMinutes: Math.round(task.totalMinutes),
    priority: task.priority || '\u4e2d',
    constraints: {
      avoidWeekends: Boolean(task.constraints?.avoidWeekends),
      preferredTimeOfDay: task.constraints?.preferredTimeOfDay ?? 'any',
      preferredStartTime: task.constraints?.preferredStartTime,
      preferredEndTime: task.constraints?.preferredEndTime
    },
    subtasks: subtasks.slice(0, 6).map((item, index) => ({
      title: String(item.title || task.taskName).trim(),
      minutes: Math.max(1, Math.round(Number(item.minutes || task.totalMinutes))),
      order: Number.isFinite(Number(item.order)) ? Math.round(Number(item.order)) : index + 1,
      startAt: normalizeIso(item.startAt),
      endAt: normalizeIso(item.endAt)
    }))
  };
}

function buildSystemPrompt(): string {
  return [
    'You are the task decomposition component of a calendar scheduling system.',
    'Return strict JSON only. Do not output markdown, comments, or explanations.',
    'Parse Chinese natural-language time expressions, Chinese numerals, relative dates, duration, deadline, priority, and scheduling constraints.',
    'Use nowIso and timezone from context as the source of truth for relative date calculation.',
    'You must calculate inferable relative dates yourself, including \u4eca\u5929, \u660e\u5929, \u540e\u5929, \u4e0b\u5468\u4e94, \u5468\u672b, \u4e0b\u4e2a\u6708.',
    'Do not ask the user to clarify inferable relative dates. Convert them into concrete ISO 8601 timestamps.',
    'The clarification step already asks the user for impossible-to-infer immediate expressions such as \u4e00\u4f1a\u513f, \u9a6c\u4e0a, \u7acb\u523b, \u5c3d\u5feb, and for missing totalMinutes.',
    'totalMinutes means the amount of calendar time to allocate. It is required for one-off events/reminders as well as decomposable tasks.',
    'If user provided clarification JSON in the user message, treat it as authoritative over the original ambiguous wording.',
    'The clarification JSON may contain natural-language string fields duration and deadline.',
    'If Python agent normalized context contains deadline, and it is an ISO 8601 timestamp, use that value as the authoritative deadline.',
    'If Python agent normalized context contains deadlineIso, use that value as the authoritative deadline.',
    'If Python agent normalized context contains totalMinutes, use that numeric value as the authoritative totalMinutes.',
    'Convert duration into numeric totalMinutes only when normalized context does not already provide totalMinutes.',
    'Convert deadline into a concrete ISO 8601 deadline and use it when scheduling subtasks.',
    'The sum of subtasks[].minutes must exactly equal totalMinutes.',
    'Use the user preference context when the user does not explicitly provide a scheduling preference.',
    'deadline must be an ISO 8601 string.',
    'priority must be one of: \u9ad8, \u4e2d, \u4f4e.',
    'subtasks must include concrete startAt and endAt ISO 8601 timestamps whenever enough information can be inferred from input and context.',
    'Each subtask startAt/endAt must include year, month, day, hour, minute, and second.',
    'Respect preferredStartTime, preferredEndTime, dailyFocusLimitMinutes, avoidWeekends, timezone, and nowIso from context.',
    'Generate at least 3 subtasks and at most 6 subtasks.',
    'If the work is small, still split it into 3 meaningful lightweight subtasks.',
    'The required JSON shape is:',
    JSON.stringify({
      taskName: '\u5b8c\u6210\u5f00\u9898\u62a5\u544a',
      deadline: '2026-08-14T23:59:00+08:00',
      totalMinutes: 600,
      priority: '\u9ad8',
      constraints: {
        avoidWeekends: true,
        preferredTimeOfDay: 'evening',
        preferredStartTime: '19:00',
        preferredEndTime: '23:00'
      },
      subtasks: [
        { title: '\u8d44\u6599\u6536\u96c6', minutes: 120, order: 1, startAt: '2026-08-12T19:00:00+08:00', endAt: '2026-08-12T21:00:00+08:00' },
        { title: '\u64b0\u5199\u521d\u7a3f', minutes: 300, order: 2, startAt: '2026-08-13T19:00:00+08:00', endAt: '2026-08-14T00:00:00+08:00' },
        { title: '\u4fee\u6539\u5b8c\u5584', minutes: 180, order: 3, startAt: '2026-08-14T19:00:00+08:00', endAt: '2026-08-14T22:00:00+08:00' }
      ]
    })
  ].join('\n');
}

export async function parseTaskWithDeepSeek(input: string, context: ParseTaskContext): Promise<ParsedScheduleTask> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

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
      model,
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt()
        },
        {
          role: 'user',
          content: JSON.stringify({
            input,
            context
          })
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 2200,
      stream: false
    })
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek request failed: HTTP ${response.status} ${rawText}`);
  }

  const data = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek returned empty content');
  }

  return normalizeParsedTask(JSON.parse(content));
}

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
    priority: task.priority || '中',
    constraints: {
      avoidWeekends: Boolean(task.constraints?.avoidWeekends),
      preferredTimeOfDay: task.constraints?.preferredTimeOfDay ?? 'any',
      preferredStartTime: task.constraints?.preferredStartTime,
      preferredEndTime: task.constraints?.preferredEndTime
    },
    subtasks: subtasks.map((item, index) => ({
      title: String(item.title || task.taskName).trim(),
      minutes: Math.max(30, Math.round(Number(item.minutes || task.totalMinutes))),
      order: Number.isFinite(Number(item.order)) ? Math.round(Number(item.order)) : index + 1
    }))
  };
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
          content: [
            '你是日程排期系统中的任务拆分 agent。',
            '你只负责把用户自然语言解析成严格 JSON，不要输出 markdown，不要解释。',
            '需要理解中文数字，例如“十个小时”=600 分钟。',
            '需要理解中文相对日期，例如“下周五”。',
            'deadline 必须输出 ISO 8601 字符串。',
            'priority 只能是 高 / 中 / 低。',
            '如果用户没有明确偏好时间，使用上下文中的 preferredStartTime 和 preferredEndTime。',
            'JSON 格式必须为：',
            JSON.stringify({
              taskName: '完成开题报告',
              deadline: '2026-08-14T23:59:00+08:00',
              totalMinutes: 600,
              priority: '高',
              constraints: {
                avoidWeekends: true,
                preferredTimeOfDay: 'evening',
                preferredStartTime: '19:00',
                preferredEndTime: '23:00'
              },
              subtasks: [
                { title: '资料收集', minutes: 120, order: 1 },
                { title: '撰写初稿', minutes: 300, order: 2 },
                { title: '修改完善', minutes: 180, order: 3 }
              ]
            })
          ].join('\n')
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
      max_tokens: 1600,
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

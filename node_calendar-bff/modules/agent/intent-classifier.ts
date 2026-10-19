import type { SchedulingSessionState } from './session-compression';

/**
 * LLM 意图识别器 —— 意图的唯一判断者。
 *
 * 设计约定（2026-09-08 与用户对齐）：
 * 1. 一条用户输入可能包含多个需求（"继续上次那个任务，另外十分钟后提醒我洗澡"），
 *    因此输出是 operations 数组，不限制条数；resume_pending 永远排最前。
 * 2. 是否需要任务拆分、是否表达"继续/恢复"的意思、CRUD 参数抽取，全部由 LLM 语义判断，
 *    代码不写死关键词。关键词启发式只在 LLM 不可用时作为最后兜底（fallbackUsed=true）。
 * 3. "继续"类语义要求 LLM 输出 resume_pending；是否真的可恢复由执行器结合任务队列判断。
 */

export type IntentOperationKind =
  | 'chat'
  | 'new_task'
  | 'resume_pending'
  | 'event_create'
  | 'event_update'
  | 'event_delete'
  | 'event_query';

export interface IntentEventPayload {
  title: string;
  startTime: string;
  endTime: string;
  location?: string | null;
  category?: string;
  priority?: string;
  note?: string | null;
  status?: string;
}

export interface IntentEventTarget {
  eventId?: string;
  title?: string;
  date?: string;
  rangeStart?: string;
  rangeEnd?: string;
}

export interface IntentEventPatch {
  title?: string;
  startTime?: string;
  endTime?: string;
  /** 相对时间位移（分钟）：正数=推迟，负数=提前。由执行器在找到原日程后计算新时间 */
  shiftMinutes?: number;
  location?: string | null;
  note?: string | null;
  status?: string;
  priority?: string;
  category?: string;
}

export interface IntentOperation {
  kind: IntentOperationKind;
  /** new_task：从中抽取出的纯任务描述 */
  taskText?: string;
  /** event_create 的完整日程参数（时间必须是 ISO 8601，相对时间由 LLM 根据 nowIso 计算） */
  event?: Partial<IntentEventPayload> & { durationMinutes?: number; allowConflict?: boolean };
  /** event_update / event_delete / event_query 的定位条件 */
  target?: IntentEventTarget;
  /** event_update 的修改内容 */
  patch?: IntentEventPatch;
  /** 用户明确接受时间冲突（"冲突也安排/照常"）：创建/改时间时跳过冲突拦截 */
  allowConflict?: boolean;
  /** chat：LLM 已经组织好的直接回答 */
  answer?: string;
}

export interface IntentClassification {
  operations: IntentOperation[];
  reason: string;
  wantsResume: boolean;
  fallbackUsed: boolean;
}

/** 可恢复任务上下文：由调用方从任务队列（pending manual_pause 断点）读出后传入 */
export interface ResumeQueueContext {
  hasPendingJob: boolean;
  /** 上次手动终止的任务的一句话描述（原始输入） */
  pendingJobInput: string | null;
  /** 上次执行到的步骤描述（来自任务事件日志），null 表示刚开始就被终止 */
  pendingJobLastStep: string | null;
  pendingJobPausedAt: string | null;
}

interface ClassifyContext {
  state: SchedulingSessionState;
  resume: ResumeQueueContext;
  nowIso: string;
  timezone: string;
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

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

async function callDeepSeekJson(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  maxTokens = 2000
): Promise<Record<string, unknown>> {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY');
  }

  // 一次性自动重试：评测中发现并发下偶发 fetch failed / 429 / 5xx，
  // 这类瞬时错误不该直接降级到关键词兜底，隔 1s 重试一次再放弃
  const MAX_ATTEMPTS = 2;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
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
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          lastError = new Error(`HTTP ${response.status} ${rawText}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        throw new Error(`DeepSeek intent-classifier request failed: HTTP ${response.status} ${rawText}`);
      }
      const data = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = data.choices?.[0]?.message?.content || '';
      return parseJsonObject(content);
    } catch (error) {
      // 网络层错误（fetch failed 等）：重试一次；非网络错误（JSON 解析等）直接抛出
      const isNetworkError = error instanceof TypeError;
      if (isNetworkError && attempt < MAX_ATTEMPTS) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('DeepSeek request failed after retry');
}

/**
 * 生成带时区偏移的"当前时间" ISO 字符串（如 2026-09-08T16:47:30+08:00）。
 * 不能用 new Date().toISOString()：那是 UTC（Z 结尾），LLM 会误以为它是本地时间，
 * 换算相对时间（"三分钟后"）时再加一次 +8，导致日程被排到 8 小时后。
 */
export function nowIsoWithOffset(offsetMinutes = 8 * 60): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetMinutes * 60 * 1000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

function buildClassifierSystemPrompt(): string {
  return [
    '你是日程 Agent 的意图识别器。用户的一句话可能同时包含多个需求，你需要把它拆成一组有序操作。',
    '只返回 JSON object，不要 markdown，不要解释。',
    '',
    '操作类型（kind）定义：',
    '- resume_pending：用户表达了"继续/恢复上次被终止的任务"的意思。语义判断，不限于字面"继续"，例如"那个没弄完的接着弄完""接着上次来""帮我把它做完"都算。若 resumeQueue 为空，不要输出此操作，改为 chat 并在 answer 里告知没有可恢复的任务。',
    '- new_task：用户提出新的排期/安排需求（无论简单复杂，是否拆分由下游 LLM 决定，你只负责识别"这是个新任务"）。taskText 填从原话中剥离出的纯任务描述。',
    '- event_create：直接创建单条日程/提醒（如"十分钟后提醒我洗澡"）。event 里给 title、startTime、endTime（ISO 8601，相对时间由你根据 nowIso 计算）、category（工作/学习/生活/面试）、priority（高/中/低）、status（未开始）。提醒类默认时长 15 分钟。',
    '- event_update / event_delete / event_query：对已有日程的改/删/查。target 里给定位条件（title 关键词、date 或 rangeStart/rangeEnd），update 的修改内容放 patch（ISO 时间）。',
    '- chat：寒暄、能力咨询、普通问答、闲聊。answer 里给完整中文回答。',
    '',
    '规则：',
    '1. 一句话含多个需求时全部拆出，不限制条数；resume_pending 如果存在必须排在数组第一位。',
    '2. 只有当用户表达"继续之前没做完的事"才输出 resume_pending；全新需求是 new_task，两者互斥。',
    '3. 用户给出新任务（resume_pending 不存在）时无需你处理旧任务，执行器会自动丢弃。',
    '4. 你的输出只是路由建议，不是最终判决；执行器会做字段校验、冲突检测和必要的路由升级。',
    '5. 相对时间提醒（"N 分钟后/小时后提醒我 X""半小时后提醒我开会"）是原子提醒，一律 event_create，不是 new_task——它不涉及排期、拆分或空闲计算。',
    '5b. 用户给出明确日期+时间点的单件事（"下周一下午三点给我排一个聚会""明晚7点安排聚餐""周五上午10点帮我排个面试"）也是 event_create，不是 new_task——开始时间已定，不需要排期/拆分/找空闲，更不要向用户追问字段。时长没说时按活动类型给合理默认时长并输出对应 endTime：聚会/聚餐约 120 分钟、会议/面试/健身约 60 分钟、提醒类 15 分钟。',
    '5c. 只有时长但没有明确开始时间的安排（如"排两小时复习""帮我安排 3 小时写论文"）优先输出 new_task。它可能需要结合空闲时间、跨天拆分或用户偏好，不要强行 event_create。',
    '5d. 如果你拿不准是 event_create 还是 new_task，优先输出 new_task；复杂排期是简单创建的超集，多跑节点可以接受，误判成简单会导致功能缺失。',
    '5e. 如果用户输入里包含"用户纠错：这不是简单日程或直接回答，请按复杂排期 Agent 流程重新规划"，必须输出 new_task，taskText 使用纠错前的原始需求。',
    '6. 所有时间字段必须是 ISO 8601 完整时间戳且必须带时区偏移（+08:00），格式示例：2026-09-08T16:50:00+08:00。nowIso 本身已带偏移，它就是用户当地的当前时刻——"三分钟后"= nowIso 直接加 3 分钟，不要做任何额外的时区加减，更不要输出 Z 结尾的 UTC 时间。',
    '7. event_update / event_delete 的 target.title 必填——从用户原话提取日程名称关键词（如"洗澡推迟一下"→ title="洗澡"；日程叫「提醒我洗澡」时提取"洗澡"即可，执行器会做包含匹配）。',
    '8. 相对时间修改（"在原基础上推迟/提前 N 小时/分钟"）不要自己猜绝对时间：patch 里输出 shiftMinutes（分钟数，推迟为正、提前为负），执行器会基于日程当前时间计算新时间。',
    '9. allowConflict 判断优先级很高：只要用户的话里出现"冲突也……""有冲突也没事/没关系""照常安排/照常改/照原计划""都要""不用管冲突"这类表述，无论它出现在句首还是句尾，该操作的 allowConflict 必须输出 true。例如"洗澡冲突也照常推迟一小时"→ event_update 且 allowConflict=true；"半小时后提醒我开会，冲突也照常安排"→ event_create 且 allowConflict=true。没有这类表述时才不输出。',
    '10. 拿不准是闲聊还是任务时，优先 chat 并在 answer 里向用户确认。',
    '',
    '输出 JSON schema：',
    '{"operations":[{"kind":"resume_pending"},{"kind":"new_task","taskText":"..."},{"kind":"event_create","event":{...},"allowConflict":false},{"kind":"event_update","target":{"title":"洗澡"},"patch":{"shiftMinutes":60},"allowConflict":false},{"kind":"event_delete","target":{...}},{"kind":"event_query","target":{...}},{"kind":"chat","answer":"..."}],"wantsResume":false,"reason":"一句话判断依据"}'
  ].join('\n');
}

const VALID_KINDS: IntentOperationKind[] = [
  'chat',
  'new_task',
  'resume_pending',
  'event_create',
  'event_update',
  'event_delete',  'event_query'
];

function normalizeOperation(value: unknown, resume: ResumeQueueContext): IntentOperation | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!record) return null;
  const kind = typeof record.kind === 'string' ? (record.kind as IntentOperationKind) : null;
  if (!kind || !VALID_KINDS.includes(kind)) return null;
  if (kind === 'resume_pending' && !resume.hasPendingJob) {
    // 队列为空时把 resume 降级为 chat 提示，由执行器输出"没有可恢复的任务"
    return { kind: 'chat', answer: '当前没有可恢复的任务——上次没有被手动终止的未完成任务。你可以直接告诉我新的安排。' };
  }
  const operation: IntentOperation = { kind };
  if (typeof record.taskText === 'string' && record.taskText.trim()) {
    operation.taskText = record.taskText.trim();
  }
  if (record.event && typeof record.event === 'object') operation.event = record.event as IntentOperation['event'];
  if (record.target && typeof record.target === 'object') operation.target = record.target as IntentEventTarget;
  if (record.patch && typeof record.patch === 'object') operation.patch = record.patch as IntentEventPatch;
  // allowConflict：LLM 可能放在操作顶层，也可能放在 event 里（event 是整体透传的，顶层要单独拷贝）
  if (record.allowConflict === true) operation.allowConflict = true;
  if (typeof record.answer === 'string' && record.answer.trim()) operation.answer = record.answer.trim();
  return operation;
}

function orderOperations(operations: IntentOperation[]): IntentOperation[] {
  // resume_pending 排最前：它可能改变任务队列状态，后续操作基于新状态执行
  const resume = operations.filter((op) => op.kind === 'resume_pending');
  const rest = operations.filter((op) => op.kind !== 'resume_pending');
  return [...resume, ...rest];
}

function normalizeClassification(value: Record<string, unknown>, resume: ResumeQueueContext): IntentClassification {
  const rawOperations = Array.isArray(value.operations) ? value.operations : [];
  const operations = orderOperations(
    rawOperations
      .map((item) => normalizeOperation(item, resume))
      .filter((item): item is IntentOperation => item !== null)
  );
  return {
    operations,
    reason: typeof value.reason === 'string' ? value.reason : 'LLM intent classifier returned a decision',
    wantsResume: operations.some((op) => op.kind === 'resume_pending'),
    fallbackUsed: false
  };
}

/**
 * 兜底：LLM 不可用时退回关键词启发式（仅最后防线，主路径永远是 LLM）。
 */
function buildFallbackClassification(input: string, resume: ResumeQueueContext): IntentClassification {
  const normalized = input.trim().toLowerCase().replace(/[！!。.\s]/g, '');
  const greetings = new Set(['你好', '您好', 'hello', 'hi', 'hey', '在吗', '在不在', '嗨', '哈喽']);
  if (greetings.has(normalized)) {
    return {
      operations: [{ kind: 'chat', answer: '你好，我在。你可以告诉我目标、截止时间和预计花费时间，我再帮你生成排期方案。' }],
      reason: '兜底：寒暄',
      wantsResume: false,
      fallbackUsed: true
    };
  }
  if (resume.hasPendingJob && /^(继续|接着|恢复)(吧|一下)?[。！!]?$/.test(input.trim())) {
    return {
      operations: [{ kind: 'resume_pending' }],
      reason: '兜底：明确的继续指令',
      wantsResume: true,
      fallbackUsed: true
    };
  }
  return {
    operations: [{ kind: 'new_task', taskText: input }],
    reason: '兜底：LLM 不可用，按新任务处理',
    wantsResume: false,
    fallbackUsed: true
  };
}

export async function classifyUserIntent(input: string, context: ClassifyContext): Promise<IntentClassification> {
  if (!getDeepSeekApiKey()) {
    return buildFallbackClassification(input, context.resume);
  }

  try {
    const result = await callDeepSeekJson([
      { role: 'system', content: buildClassifierSystemPrompt() },
      {
        role: 'user',
        content: JSON.stringify({
          input,
          nowIso: context.nowIso,
          timezone: context.timezone,
          resumeQueue: context.resume.hasPendingJob
            ? {
                pendingJobInput: context.resume.pendingJobInput,
                lastStep: context.resume.pendingJobLastStep,
                pausedAt: context.resume.pendingJobPausedAt
              }
            : null,
          sessionSummary: context.state.summary,
          recentMessages: context.state.messages.slice(-8)
        })
      }
    ]);
    const classification = normalizeClassification(result, context.resume);
    if (classification.operations.length === 0) {
      // LLM 拆出来的操作全部不合法：视为普通问答兜底，不猜
      return {
        operations: [{ kind: 'chat', answer: '我没有完全理解你的意思。你可以直接告诉我：要安排什么任务、要查改删哪条日程，或者"继续"上次的任务。' }],
        reason: 'LLM 未输出任何合法操作',
        wantsResume: false,
        fallbackUsed: true
      };
    }
    return classification;
  } catch (error) {
    console.warn(
      '[IntentClassifier] LLM failed, using keyword fallback:',
      error instanceof Error ? error.message : error
    );
    return buildFallbackClassification(input, context.resume);
  }
}

export interface SemanticMatchCandidate {
  eventId: string;
  title: string;
  timeText: string;
}

export interface SemanticMatchResult {
  decision: 'matched' | 'none' | 'ambiguous';
  eventId?: string;
}

/**
 * 日程定位的第 2 级语义匹配（2026-09-08 与用户对齐的设计）：
 * 第 1 级子串匹配 0 命中时，把候选日程（只取本周）和用户原话交给 LLM，
 * 让它做同义词/改写/指代级别的理解并选出唯一一条。
 * 拿不准（多条都像）返回 ambiguous —— 由第 3 级弹选项框让用户选。
 * LLM 不可用或调用失败时返回 none，等价于"没找到"，不猜。
 */
export async function semanticMatchEventByLlm(
  rawInput: string,
  candidates: SemanticMatchCandidate[]
): Promise<SemanticMatchResult> {
  if (!rawInput.trim() || candidates.length === 0) {
    return { decision: 'none' };
  }
  if (!getDeepSeekApiKey()) {
    return { decision: 'none' };
  }

  try {
    const result = await callDeepSeekJson(
      [
        {
          role: 'system',
          content: [
            '你是日程定位器。用户想对他已有的某条日程做操作（改/删），但说法和日程标题对不上。',
            '下面是候选日程列表（id、标题、时间）和用户的原话。请判断用户指的是哪一条。',
            '只返回 JSON object，不要 markdown。',
            'Schema: {"decision":"matched|none|ambiguous","eventId":"候选里的 id 或空串"}',
            '规则：',
            '1. 同义词、口语改写、上下位词都算匹配（"洗漱那件事"可以指「提醒我洗澡」，"沐浴"也可以）。',
            '2. 结合原话里的时间线索排除不相干候选（"推迟"说明是还没发生的事）。',
            '3. 只有一条明显是用户所指 → matched + eventId。',
            '4. 没有任何一条沾边 → none。',
            '5. 多条都说得通、无法唯一确定 → ambiguous（不要猜）。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            rawInput,
            candidates: candidates.map((candidate) => ({
              eventId: candidate.eventId,
              title: candidate.title,
              time: candidate.timeText
            }))
          })
        }
      ],
      400
    );

    const decision = typeof result.decision === 'string' ? result.decision : '';
    const eventId = typeof result.eventId === 'string' ? result.eventId.trim() : '';
    if (decision === 'matched' && eventId) {
      const exists = candidates.some((candidate) => candidate.eventId === eventId);
      // LLM 编造 id 时按 none 处理，不猜
      return exists ? { decision: 'matched', eventId } : { decision: 'none' };
    }
    if (decision === 'ambiguous') {
      return { decision: 'ambiguous' };
    }
    return { decision: 'none' };
  } catch (error) {
    console.warn(
      '[IntentClassifier] semantic match failed, treat as none:',
      error instanceof Error ? error.message : error
    );
    return { decision: 'none' };
  }
}

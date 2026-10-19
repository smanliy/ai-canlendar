import type { IntentOperationKind } from '../modules/agent/intent-classifier';

/**
 * 意图识别器评测集（50 条）。
 *
 * 断言模型：每条用例给一组"期望操作"，按顺序与 LLM 输出的 operations 对比。
 * - kind 必须完全相等（数量、顺序都要对，resume_pending 必须排第一）
 * - 其余字段为可选断言，只检查写出来的字段
 */

export interface ExpectedOp {
  kind: IntentOperationKind;
  /** new_task：taskText 应包含的关键词 */
  taskTextIncludes?: string;
  /** event_update/delete/query：target.title 应包含的关键词 */
  targetTitleIncludes?: string;
  /** event_update：patch.shiftMinutes 期望值（分钟） */
  shiftMinutes?: number;
  /** 该操作应带 allowConflict=true */
  allowConflict?: boolean;
  /** event_create：event.title 应包含的关键词 */
  eventTitleIncludes?: string;
  /** event_create：开始时间应落在 now + [min, max] 分钟区间内（相对时间类用例） */
  startOffsetMinutes?: [number, number];
  /** chat：answer 非空 */
  answerNonEmpty?: boolean;
}

export interface IntentTestCase {
  id: string;
  category: string;
  input: string;
  /** 模拟可恢复队列里是否有被手动终止的任务 */
  hasPendingJob?: boolean;
  expectedOps: ExpectedOp[];
  note?: string;
}

export const INTENT_TEST_CASES: IntentTestCase[] = [
  // ===== A. 原子提醒 → event_create（8 条）=====
  { id: 'A01', category: '原子提醒', input: '三分钟后提醒我洗澡',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '洗澡', startOffsetMinutes: [2, 5] }] },
  { id: 'A02', category: '原子提醒', input: '半小时后提醒我开会',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '开会', startOffsetMinutes: [28, 33] }] },
  { id: 'A03', category: '原子提醒', input: '一个小时后提醒我吃药',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '吃药', startOffsetMinutes: [58, 63] }] },
  { id: 'A04', category: '原子提醒', input: '二十分钟后提醒我喝水',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '喝水', startOffsetMinutes: [18, 23] }] },
  { id: 'A05', category: '原子提醒', input: '今晚8点提醒我打电话给妈妈',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '妈妈' }] },
  { id: 'A06', category: '原子提醒', input: '明天上午十点提醒我交周报',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '周报' }] },
  { id: 'A07', category: '原子提醒', input: '后天下午3点提醒我面试',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '面试' }] },
  { id: 'A08', category: '原子提醒', input: '10分钟后提醒我起身活动一下',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '活动', startOffsetMinutes: [8, 13] }] },
  { id: 'A09', category: '原子提醒', input: '下周一下午三点给我排一个聚会',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '聚会' }],
    note: '有明确开始时间的单件事是 event_create，不是 new_task；时长缺失由 LLM 给合理默认' },
  { id: 'A10', category: '原子提醒', input: '明晚7点安排一个聚餐',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '聚餐' }] },

  // ===== B. 新任务（需拆分排期）→ new_task（6 条）=====
  { id: 'B01', category: '新任务拆分', input: '帮我准备周五的项目汇报',
    expectedOps: [{ kind: 'new_task', taskTextIncludes: '汇报' }] },
  { id: 'B02', category: '新任务拆分', input: '我要在下周三前完成毕业论文初稿，帮我安排一下',
    expectedOps: [{ kind: 'new_task', taskTextIncludes: '论文' }] },
  { id: 'B03', category: '新任务拆分', input: '帮我规划一下国庆旅行',
    expectedOps: [{ kind: 'new_task', taskTextIncludes: '旅行' }] },
  { id: 'B04', category: '新任务拆分', input: '三天内入门Python数据分析，帮我排期',
    expectedOps: [{ kind: 'new_task' }] },
  { id: 'B05', category: '新任务拆分', input: '下周五前要交付设计稿，帮我排一下时间',
    expectedOps: [{ kind: 'new_task', taskTextIncludes: '设计' }] },
  { id: 'B06', category: '新任务拆分', input: '我想在一个月内瘦5斤，帮我安排计划',
    expectedOps: [{ kind: 'new_task' }] },

  // ===== C. 恢复任务（队列里有被终止的任务）→ resume_pending（5 条）=====
  { id: 'C01', category: '恢复任务', input: '继续', hasPendingJob: true,
    expectedOps: [{ kind: 'resume_pending' }] },
  { id: 'C02', category: '恢复任务', input: '接着上次来', hasPendingJob: true,
    expectedOps: [{ kind: 'resume_pending' }] },
  { id: 'C03', category: '恢复任务', input: '那个没弄完的接着弄完', hasPendingJob: true,
    expectedOps: [{ kind: 'resume_pending' }] },
  { id: 'C04', category: '恢复任务', input: '帮我把它做完', hasPendingJob: true,
    expectedOps: [{ kind: 'resume_pending' }] },
  { id: 'C05', category: '恢复任务', input: '继续刚才被打断的那个任务', hasPendingJob: true,
    expectedOps: [{ kind: 'resume_pending' }] },

  // ===== D. 恢复但队列为空 → 降级 chat（2 条）=====
  { id: 'D01', category: '恢复降级', input: '继续', hasPendingJob: false,
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }],
    note: '队列为空时应降级为 chat 并提示没有可恢复任务' },
  { id: 'D02', category: '恢复降级', input: '接着上次那个任务', hasPendingJob: false,
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }] },

  // ===== E. 查询 → event_query（5 条）=====
  { id: 'E01', category: '日程查询', input: '我今天有什么安排',
    expectedOps: [{ kind: 'event_query' }] },
  { id: 'E02', category: '日程查询', input: '明天有哪些日程',
    expectedOps: [{ kind: 'event_query' }] },
  { id: 'E03', category: '日程查询', input: '这周有什么会议',
    expectedOps: [{ kind: 'event_query' }] },
  { id: 'E04', category: '日程查询', input: '查一下洗澡是几点',
    expectedOps: [{ kind: 'event_query', targetTitleIncludes: '洗澡' }] },
  { id: 'E05', category: '日程查询', input: '下周一我有什么安排',
    expectedOps: [{ kind: 'event_query' }] },

  // ===== F. 修改 → event_update（8 条）=====
  { id: 'F01', category: '日程修改', input: '洗澡推迟一个小时',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '洗澡', shiftMinutes: 60 }] },
  { id: 'F02', category: '日程修改', input: '把开会提前30分钟',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '开会', shiftMinutes: -30 }] },
  { id: 'F03', category: '日程修改', input: '面试改到后天下午两点',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '面试' }] },
  { id: 'F04', category: '日程修改', input: '把跑步改成游泳',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '跑步' }] },
  { id: 'F05', category: '日程修改', input: '把会议的优先级改成高',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '会议' }] },
  { id: 'F06', category: '日程修改', input: '洗澡冲突也照常推迟一小时',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '洗澡', shiftMinutes: 60, allowConflict: true }] },
  { id: 'F07', category: '日程修改', input: '把明天的汇报改到下午3点',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '汇报' }] },
  { id: 'F08', category: '日程修改', input: '健身推迟45分钟',
    expectedOps: [{ kind: 'event_update', targetTitleIncludes: '健身', shiftMinutes: 45 }] },

  // ===== G. 删除 → event_delete（5 条）=====
  { id: 'G01', category: '日程删除', input: '删掉洗澡',
    expectedOps: [{ kind: 'event_delete', targetTitleIncludes: '洗澡' }] },
  { id: 'G02', category: '日程删除', input: '取消明天的会议',
    expectedOps: [{ kind: 'event_delete', targetTitleIncludes: '会议' }] },
  { id: 'G03', category: '日程删除', input: '把跑步删了',
    expectedOps: [{ kind: 'event_delete', targetTitleIncludes: '跑步' }] },
  { id: 'G04', category: '日程删除', input: '删除后天的面试',
    expectedOps: [{ kind: 'event_delete', targetTitleIncludes: '面试' }] },
  { id: 'G05', category: '日程删除', input: '洗澡这个提醒不要了',
    expectedOps: [{ kind: 'event_delete', targetTitleIncludes: '洗澡' }] },

  // ===== H. 闲聊 → chat（5 条）=====
  { id: 'H01', category: '闲聊', input: '你好',
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }] },
  { id: 'H02', category: '闲聊', input: '你能做什么',
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }] },
  { id: 'H03', category: '闲聊', input: '讲个笑话吧',
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }] },
  { id: 'H04', category: '闲聊', input: '你是谁',
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }] },
  { id: 'H05', category: '闲聊', input: '今天心情不太好',
    expectedOps: [{ kind: 'chat', answerNonEmpty: true }] },

  // ===== I. 多需求混合（6 条）=====
  { id: 'I01', category: '多需求混合', input: '继续上次的任务，另外十分钟后提醒我洗澡', hasPendingJob: true,
    expectedOps: [
      { kind: 'resume_pending' },
      { kind: 'event_create', eventTitleIncludes: '洗澡', startOffsetMinutes: [8, 13] }
    ],
    note: 'resume_pending 必须排第一' },
  { id: 'I02', category: '多需求混合', input: '删掉洗澡，然后半小时后提醒我吃药',
    expectedOps: [
      { kind: 'event_delete', targetTitleIncludes: '洗澡' },
      { kind: 'event_create', eventTitleIncludes: '吃药', startOffsetMinutes: [28, 33] }
    ] },
  { id: 'I03', category: '多需求混合', input: '我今天有什么安排？顺便晚上8点提醒我吃药',
    expectedOps: [
      { kind: 'event_query' },
      { kind: 'event_create', eventTitleIncludes: '吃药' }
    ] },
  { id: 'I04', category: '多需求混合', input: '帮我准备季度总结，另外明天早上9点提醒我打卡',
    expectedOps: [
      { kind: 'new_task' },
      { kind: 'event_create', eventTitleIncludes: '打卡' }
    ] },
  { id: 'I05', category: '多需求混合', input: '半小时后提醒我开会，冲突也照常安排',
    expectedOps: [{ kind: 'event_create', eventTitleIncludes: '开会', allowConflict: true, startOffsetMinutes: [28, 33] }] },
  { id: 'I06', category: '多需求混合', input: '把洗澡推迟一小时，再删掉跑步',
    expectedOps: [
      { kind: 'event_update', targetTitleIncludes: '洗澡', shiftMinutes: 60 },
      { kind: 'event_delete', targetTitleIncludes: '跑步' }
    ] }
];

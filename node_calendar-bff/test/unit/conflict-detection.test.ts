/**
 * 第一课：单元测试 = 只测"这一段逻辑"，把它依赖的数据库/LLM 全部换成假的（mock）。
 *
 * 为什么选 detectEventConflicts 当教材：
 * 1. 它是纯判定逻辑（两个时间段是否重叠）——单元测试最喜欢这种函数
 * 2. 它内部要查数据库——正好用来学 mock（不然测试还得先启动 Postgres）
 *
 * 三段式结构（所有单测都长这样）：
 *   Arrange（准备）：造假数据，让被测函数以为自己在真实环境里
 *   Act（执行）：   调用被测函数
 *   Assert（断言）：检查结果是否等于预期，不等就报错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// 第一步：mock —— 把被测模块 import 的所有"有副作用的依赖"换成假货。
// 路径要从【测试文件】出发写（test/unit/ → ../../modules/...），
// vitest 会把它解析成和业务代码里 import 的同一个文件，从而完成拦截。
// 副作用包括：连数据库（prisma）、调 LLM、发 HTTP 请求。
// mock 之后，测试不再需要 Postgres、不需要 API key、毫秒级跑完。
// ============================================================
vi.mock('../../modules/agent/agent.orchestrator', () => ({
  runScheduleAgent: vi.fn()
}));
vi.mock('../../modules/events/events.service', () => ({
  listEvents: vi.fn()
}));
vi.mock('../../modules/events/events.repository', () => ({
  findEventById: vi.fn()
}));
vi.mock('../../modules/agent/agent-checkpoint.repository', () => ({
  findPendingManualPauseCheckpoint: vi.fn(),
  resolveCheckpoint: vi.fn(),
  supersedeManualPauseCheckpoints: vi.fn()
}));
vi.mock('../../modules/agent/agent-job.repository', () => ({
  abandonAgentJobById: vi.fn(),
  findAgentJob: vi.fn(),
  listAgentJobEvents: vi.fn()
}));
vi.mock('../../modules/agent/agent-planning-session.repository', () => ({
  savePlanningSession: vi.fn()
}));
vi.mock('../../modules/agent/intent-classifier', () => ({
  semanticMatchEventByLlm: vi.fn()
}));

// mock 完再 import 被测模块 —— vi.mock 会被提升到文件最顶部，
// 所以这里拿到的 detectEventConflicts 内部用的已经是假数据库了
import { detectEventConflicts } from '../../modules/agent/agent-operations';
import { listEvents } from '../../modules/events/events.service';

// vi.mocked() 只是让 TS 知道"这是 mock"，方便下面 .mockReturnValue 时有类型提示
const mockListEvents = vi.mocked(listEvents);

// 工具：造一条"数据库里的日程"。真实 DB 返回 Date 对象，
// 但接口也可能给 ISO 字符串，被测函数两种都要能处理
function fakeEvent(id: string, title: string, start: string, end: string) {
  return { id, title, startTime: new Date(start), endTime: new Date(end) };
}

// 固定一批时间，所有用例围绕它展开。
// 用 +08:00 显式时区——还记得时区踩过的坑吗？测试里绝不让时区隐式
const HOUR = (n: number) => `2026-09-10T${String(n).padStart(2, '0')}:00:00+08:00`;

describe('detectEventConflicts —— 冲突检测（区间重叠判定）', () => {
  // Arrange 的公共部分：每条用例开始前，数据库默认"空"
  beforeEach(() => {
    mockListEvents.mockReset();
    mockListEvents.mockResolvedValue([]);
  });

  it('时间完全包含 → 应检出冲突', async () => {
    // Arrange：库里已有 10:00~11:00 的会
    mockListEvents.mockResolvedValue([fakeEvent('e1', '周会', HOUR(10), HOUR(11))]);

    // Act：想新建 10:30~11:30 的日程
    const conflicts = await detectEventConflicts('user-1', '新日程', new Date('2026-09-10T10:30:00+08:00'), new Date('2026-09-10T11:30:00+08:00'));

    // Assert：必须检出一条冲突，且是那条"周会"
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].title).toBe('周会');
  });

  it('首尾相接（11:00 结束 vs 11:00 开始）→ 不算冲突（半开区间）', async () => {
    // Arrange：10:00~11:00 的会
    mockListEvents.mockResolvedValue([fakeEvent('e1', '周会', HOUR(10), HOUR(11))]);

    // Act：紧跟着 11:00~12:00 开另一个会——背靠背，不重叠
    const conflicts = await detectEventConflicts('user-1', '新日程', new Date(HOUR(11)), new Date(HOUR(12)));

    // Assert：这条规则来自 Python 侧 _intervals_overlap 的同款半开区间语义
    // [10,11) 与 [11,12) 没有交集。如果哪天有人把这行判断改成 <=，这条测试会立刻红
    expect(conflicts).toHaveLength(0);
  });

  it('完全不相交 → 不算冲突', async () => {
    mockListEvents.mockResolvedValue([fakeEvent('e1', '周会', HOUR(10), HOUR(11))]);

    const conflicts = await detectEventConflicts('user-1', '新日程', new Date(HOUR(14)), new Date(HOUR(15)));

    expect(conflicts).toHaveLength(0);
  });

  it('数据库返回 ISO 字符串而非 Date 对象 → 仍能正确判定', async () => {
    // Arrange：故意用字符串模拟某些接口层的返回形态
    mockListEvents.mockResolvedValue([
      { id: 'e1', title: '周会', startTime: HOUR(10), endTime: HOUR(11) }
    ]);

    // Act：10:45~11:15 重叠
    const conflicts = await detectEventConflicts('user-1', '新日程', new Date('2026-09-10T10:45:00+08:00'), new Date('2026-09-10T11:15:00+08:00'));

    expect(conflicts).toHaveLength(1);
  });

  it('修改日程时排除自己（excludeEventId）→ 原时间不动不算冲突', async () => {
    // Arrange：库里那条"周会"就是我要改的日程本身
    mockListEvents.mockResolvedValue([fakeEvent('e1', '周会', HOUR(10), HOUR(11))]);

    // Act：把它改成 10:00~11:30。虽然和自己"重叠"，但自己不算和自己冲突
    const conflicts = await detectEventConflicts('user-1', '周会', new Date(HOUR(10)), new Date('2026-09-10T11:30:00+08:00'), 'e1');

    expect(conflicts).toHaveLength(0);
  });

  it('修改日程且和别人撞车 → 检出的是"别人"不是自己', async () => {
    // Arrange：库里两条——自己(e1) + 别人的会(e2)
    mockListEvents.mockResolvedValue([
      fakeEvent('e1', '我的周会', HOUR(10), HOUR(11)),
      fakeEvent('e2', '别人的面试', HOUR(10), HOUR(11))
    ]);

    // Act：把 e1 改到和 e2 重叠的时段，排除 e1 自己
    const conflicts = await detectEventConflicts('user-1', '我的周会', new Date(HOUR(10)), new Date(HOUR(11)), 'e1');

    // Assert：只检出 e2
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].title).toBe('别人的面试');
  });
});

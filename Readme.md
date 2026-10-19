# AI日历（目前正在迭代丰富开发中...头脑风暴~）

## Story-这个项目的idea是如何诞生的

随着 AI 快速发展，几乎每隔一段时间都会出现新的模型、新的工具和新的工作流。AI 带来的变化也不只发生在计算机行业，短剧、编导、设计、运营等方向也在被不断影响。

我观察到一个很典型的现象：很多非计算机专业的同学也开始使用 GPT、图像生成模型等工具辅助学习和创作。比如编导专业的同学会用 AI 生成分镜、海报或视觉参考，但他们往往不知道应该系统学习哪些 Prompt 技巧，也不知道该如何把“我要学会使用 AI 工具”拆成具体、可执行的学习任务。

类似的问题也出现在考研、考公、秋招准备和技术栈学习中。用户通常不是没有目标，而是不知道如何开始：任务太大、路径不清晰、时间安排随意，最后很容易拖延或半途放弃。

因此，我开发了这个智能日历排期项目。它的核心目标不是再做一个普通日历，而是让 Agent 帮用户完成从“模糊目标”到“可执行计划”的转换：

- 理解用户输入的学习或任务目标
- 拆解成更小的原子任务
- 查询用户已有日程
- 结合用户偏好的学习时间、每日专注时长、是否避开周末等信息
- 自动计算空闲时间并生成排期
- 将最终计划写入日历，支持后续修改、删除和撤销

这个项目适用于我身边很多真实场景：考研考公复习、秋招刷题、学习新技术栈、准备作品集、学习 AI 工具和 Prompt 等。它希望解决的不是“提醒用户做事”，而是帮助用户知道“下一步应该做什么，以及什么时候做”。

目前我还尝试将这个能力封装成 MCP 工具，让 Codex 这类本地 Agent 可以直接调用日历系统，实现从对话到任务规划再到日程落库的完整闭环。

## 项目目录

```text
calendar/
├─ package.json               # npm workspaces 根配置与统一脚本
├─ package-lock.json          # 根目录统一锁文件
├─ front-react/               # React + Vite 前端
│  ├─ src/pages               # 页面入口
│  ├─ src/features            # 业务功能组件
│  ├─ src/layouts             # 布局组件
│  ├─ src/stores              # Zustand 状态管理
│  └─ src/services            # 接口封装
├─ node_calendar-bff/         # Node.js BFF 层
│  ├─ modules                 # auth / events / agent / preferences / db
│  ├─ config                  # 数据库等配置
│  ├─ scripts                 # 统计、排查脚本
│  └─ reports                 # 压缩与性能报告
├─ agent/                     # Python Agent 服务
│  ├─ app                     # Agent 服务与策略实现
│  ├─ docs                    # 流程文档
│  └─ scripts                 # 关系图、流程图生成脚本
└─ Readme.md                  # 当前说明文档
```

## 架构说明

项目整体采用「前端 + BFF + Agent」的 workspace monorepo 分层结构：

- `front-react` 负责界面展示和交互，只向后端发起请求
- `node_calendar-bff` 负责统一 API、鉴权、事件 CRUD、Agent 任务编排
- `agent` 负责更偏策略层的排期、拆解、校验和恢复逻辑

数据流大致是：

`前端 -> BFF -> PostgreSQL(Prisma) -> Agent`

其中 Agent 会参与排期推理与任务拆解，BFF 负责把结果落到日历数据与任务状态中。

### 简单日程、复杂排期与 CRUD 路由

当前系统会先在 BFF 层通过 LLM 做意图识别。这里的意图识别只是“路由建议”，不是最终判决；真正能不能执行，还要经过字段校验、已有日程查询、空闲时间计算和冲突检测。

- `event_query` / `event_delete`：查询和删除属于轻量 CRUD。LLM 只负责识别用户要查什么、删什么；BFF 定位到具体日程后直接查库或删除。删除如果命中多条，会返回候选列表让用户选择，不会猜。
- `event_create` / `event_update`：创建和修改都会先校验信息是否足够。字段足够时，BFF 构造单条日程草案，然后调用 Python Agent 的 `event-draft-check`，从“查询本地已有日程 -> 计算空闲时间 -> 冲突检测”这一段调度节点开始复用 Agent 能力。无冲突才落库；有冲突则返回结构化冲突决策卡，由用户选择保留冲突、后移原有日程或取消。
- `new_task`：用户输入的是模糊目标、只有时长没有开始时间，或者 LLM 拿不准简单/复杂时，优先进入完整 Agent 排期流程。是否需要拆分不靠硬编码规则，而是由下游 LLM 判断；代码层面只做一个路由分支。

系统的 fallback 原则是：不确定时宁可升级到复杂排期，因为复杂流程是简单创建的超集，多跑几个节点只是成本增加；误判成简单则可能缺少空闲时间计算、跨天拆分或用户偏好处理。若简单创建/修改执行中发现信息不足或更像排期任务，会自动升级为复杂 Agent 流程。前端也提供“这不是我想要的，转复杂规划”纠错入口，并把纠错信号写入对话日志，便于后续做 badcase 分析和 prompt 迭代。

## 环境要求

- Node.js：前端和 BFF 都依赖 Node 环境
- npm：用于安装 workspace 依赖与执行根目录脚本
- Python 3：用于 `agent` 服务
- PostgreSQL：`node_calendar-bff` 的 Prisma 数据库

建议同时准备好以下环境变量：

- `node_calendar-bff/.env`
- `agent/.env`

其中 BFF 至少需要可用的 `DATABASE_URL`，其余按你本地实际配置补齐即可。

## Workspace Monorepo 是什么

当前仓库使用 npm workspaces 管理前端和 BFF：

- 根目录 `package.json` 负责声明 workspace、统一脚本和公共开发依赖。
- 根目录 `package-lock.json` 是唯一 JS 锁文件，避免每个子项目各自锁依赖导致版本漂移。
- `front-react` 和 `node_calendar-bff` 保留自己的 `package.json`，各自声明业务依赖。
- `agent` 是 Python 服务，不放进 npm workspace，但由根目录脚本统一启动。

这种结构适合一个产品里同时维护前端、后端和 Agent 服务：代码分层清楚，安装和构建入口统一，也更接近团队项目的仓库组织方式。

## 本地启动方式

先启动 PostgreSQL，并准备好 `node_calendar-bff/.env` 和 `agent/.env`。

### 1. 安装依赖

```powershell
cd E:\Lenovo\Documents\learn\calendar
npm install
```

### 2. 生成 Prisma Client 并迁移数据库

```powershell
npm run generate
npm run migrate
```

### 3. 一次启动全部服务

```powershell
npm run dev
```

默认端口：

- BFF：`http://localhost:3000`
- Python Agent：`http://127.0.0.1:8001`
- 前端：`http://localhost:5173`

### 单独启动某个服务

```powershell
npm run dev:bff
npm run dev:front
npm run dev:agent
```

### 常用检查

```powershell
npm run typecheck
npm run build
npm test
```

`npm run build` 会构建前端，并对 BFF 做 TypeScript 类型检查。

## 项目目的

市面上现有的日历、待办类工具大多属于**记录型产品**，仅负责存储任务与推送提醒，无法对模糊、长周期的目标自动完成任务拆解和全局排期；而绝大多数基于大模型实现的日程 Demo，往往将全部逻辑交由大模型一次性生成，缺少独立的调度流程，模型输出不可控、方案难以多轮迭代优化。

不同于直接把所有任务丢给大模型的实现思路，我选择搭建一条**串行调度主循环**作为 Agent 的执行骨架，主动划分大模型语义推理与本地业务校验的职责边界：把自然语言解析、复杂任务拆解这类非确定性推理交给大模型；时间冲突检测、日程规则校验等确定性逻辑下沉到本地代码执行。
以此提升整个 Agent 链路的稳定性与可控性。本项目旨在帮助用户仅通过一句模糊的目标描述，便可自动生成多套可选的排期方案，降低人工比对空闲时间、反复调整日程带来的规划成本。同时配套实现上下文 Token 压缩方案，优化长会话场景下的资源开销，支持用户多轮对话打磨一份长期计划。

## UI

### 关于主agent菜单

![图片](https://github.com/smanliy/picx-images-hosting/raw/master/image.1sfsap8v2s.webp)

- 介绍

### 关于日历menu

![图片](https://github.com/smanliy/picx-images-hosting/raw/master/download.8z79nzv6e3.webp)

- 介绍：

1. 该表借助ant-design 设计，显示每周日/周/月计划，同时支持按标签统计，方便查看事件密度
2. 关于设计巧思：

- 右侧小老鼠手中白色的打气筒可以点击，每点击一次，气球都会变大一次
- 最大点击次数为8 当点击到第九下的时候，气球会爆炸开花，然后封面上翻
- 同时上面也支持直接翻面，打气非必要操作，只是设计巧思

### 关于token账单

![图片](https://github.com/smanliy/picx-images-hosting/raw/master/image.9ddpewr6rd.webp)

- 介绍:
- 这里是压缩机制的量化成果
- 首先没有采用对照的原因是：比如我前面几轮对话采用非压缩，后面几轮采用压缩，看起来是合理的，但是这样子其实变量有两个，在压缩的时候一定要比非压缩的token量要大，因为压缩承载了非压缩的token数
- 所以我才用初始值相同，知道手动/自动压缩前，两条折现重叠，压缩后，会出现明显差距
- 也就是说，区分压缩和非压缩不是每一个节点的对比，而是整条趋势的对比，非压缩，整条线是线性增长的，而压缩的在某些节点可能存在小幅增长，甚至可能会出现回落
- 当然压缩也是会消耗token,为了显示出是压缩导致的token变高还是本身token量爆炸，我会在节点表明是手动压缩还是自动压缩
- 一些极个别压缩后的点消耗高于非压缩的是允许的，因为从长久来看，这种消耗可以忽略不计

### 后续扩展：Redis 队列与分布式锁

当前项目的 Agent 后台任务队列基于 PostgreSQL 实现，核心表为 `AgentJob`、`AgentJobEvent`、`AgentCheckpoint`。Worker 通过数据库事务和 `FOR UPDATE SKIP LOCKED` 领取 `queued` 状态的任务，并写入 `lockedBy`、`lockedAt`、`heartbeatAt` 等字段，保证同一任务在并发 Worker 下不会被重复消费。

之所以当前没有直接引入 Redis，是因为本项目的 Agent 任务更强调可靠性和可恢复性，而不是极高吞吐量。一次 Agent 排期任务涉及大模型调用、外部搜索、空闲时间计算、冲突检测、用户决策挂起和最终落库，这些状态本身都需要持久化保存。因此，现阶段使用 PostgreSQL 作为任务队列，可以减少额外中间件依赖，并保证任务状态、执行结果、checkpoint 和事件日志处于同一个持久化系统中。

如果后续项目复杂度继续提升，例如出现以下场景，则可以考虑引入 Redis：

- Agent 请求量明显增大，数据库轮询成为性能瓶颈
- 后台 Worker 需要多实例部署，并承担更高频的任务调度
- 需要更灵活的延迟任务、优先级队列、失败重试和死信队列
- 需要对用户请求做限流、防重复提交、短期缓存
- SSE 连接、在线状态、临时执行上下文等短生命周期状态增多

引入 Redis 后，可以将架构演进为：

```text
前端
  ↓
Node BFF
  ↓
Redis / BullMQ 负责任务排队、延迟执行、重试、并发控制
  ↓
Worker 消费任务并调用 Python Agent
  ↓
PostgreSQL 持久化 AgentJob、AgentJobEvent、AgentCheckpoint、CalendarEvent
```

思路：
- 使用 SET lockKey value NX EX ttl 抢占锁。
- value 保存唯一标识，例如 workerId + requestId，避免误删其他 Worker 的锁。
- 释放锁时使用 Lua 脚本校验锁归属并删除，保证 get + del 的原子性。
- 对长时间运行的 Agent 任务，需要实现锁续期机制，避免任务未执行完锁提前过期。
- Worker 异常退出后，依赖锁 TTL 自动释放，避免死锁。
- 任务最终结果仍然写回 PostgreSQL，保证可追溯和可恢复。

### 近期头脑风暴（后续逐步添加）

- 将项目打包成桌面端，并构造桌面助手，支持直接输入需求后台执行，且可以通过邮箱通知到用户
- 后续增加：用户需要批注修改时重新生成方案，用户某一件子任务由于意外没有完成需要重新排期or措施

# AI日历（目前正在迭代丰富开发中...头脑风暴~）

## 项目目录

```text
calendar/
├─ front-react/               # React + Vite 前端
│  ├─ src/pages               # 页面入口
│  ├─ src/features            # 业务功能组件
│  ├─ src/layouts             # 布局组件
│  ├─ src/stores              # Zustand 状态管理
│  └─ src/services            # 接口封装
├─ node_calendar-bff/         # Node.js BFF 层
│  ├─ modules                 # auth / events / agent / integrations
│  ├─ config                  # 数据库等配置
│  ├─ scripts                 # 统计、排查脚本
│  └─ reports                 # 压缩与性能报告
├─ agent/                     # Python Agent 服务
│  ├─ app                     # Agent 服务与策略实现
│  ├─ docs                    # 流程文档
│  └─ scripts                 # 关系图、流程图生成脚本
├─ openclaw-calendar-bridge/  # OpenClaw 插件桥接层
│  ├─ src                     # 插件源码
│  ├─ dist                    # 构建产物
│  └─ *.ps1                   # 构建 / 校验 / 启动脚本
├─ skills/                    # Codex 相关技能配置
└─ Readme.md                  # 当前说明文档
```

## 架构说明

项目整体采用「前端 + BFF + Agent + 插件桥接」的分层结构：

- `front-react` 负责界面展示和交互，只向后端发起请求
- `node_calendar-bff` 负责统一 API、鉴权、事件 CRUD、Agent 任务编排，以及与 OpenClaw 的集成入口
- `agent` 负责更偏策略层的排期、拆解、校验和恢复逻辑
- `openclaw-calendar-bridge` 负责把 OpenClaw 的能力接到本项目的 BFF 上，便于后续扩展外部入口

数据流大致是：

`前端 -> BFF -> PostgreSQL(Prisma) -> Agent / 插件桥接`

其中 Agent 会参与排期推理与任务拆解，BFF 负责把结果落到日历数据与任务状态中。

## 环境要求

- Node.js：前端、BFF、OpenClaw 桥接都依赖 Node 环境
- npm / pnpm：用于安装依赖与执行脚本
- Python 3：用于 `agent` 服务
- PostgreSQL：`node_calendar-bff` 的 Prisma 数据库
- PowerShell：`openclaw-calendar-bridge` 的本地脚本目前是 `.ps1`
- OpenClaw：如果要跑插件桥接，需要本地安装并可调用 OpenClaw

建议同时准备好以下环境变量：

- `node_calendar-bff/.env`
- `agent/.env`

其中 BFF 至少需要可用的 `DATABASE_URL`，其余按你本地实际配置补齐即可。

## 本地启动方式

先启动数据库，再按下面顺序启动各服务。

### 1. 启动 BFF

```bash
cd node_calendar-bff
npm install
npm run dev
```

默认监听 `http://localhost:3000`。

### 2. 启动 Python Agent

```bash
cd agent/app
python main.py
```

默认监听 `http://127.0.0.1:8001`，也可以通过 `PY_AGENT_HOST` 和 `PY_AGENT_PORT` 自定义。

### 3. 启动前端

```bash
cd front-react
npm install
npm run dev
```

默认访问 `http://localhost:5173`。

### 4. 启动 OpenClaw 桥接（可选）

```bash
cd openclaw-calendar-bridge
npm install
npm run plugin:build
npm run openclaw:local
```

如果你只是本地跑页面和后端，这一步可以先不启用；如果要测试 OpenClaw 集成，再把它打开。(目前实现遇到困难，正在解决中)

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

### 近期头脑风暴（后续逐步添加）

- 将项目打包成桌面端，并构造桌面助手，支持直接输入需求后台执行，且可以通过邮箱通知到用户
- 后续增加：用户需要批注修改时重新生成方案，用户某一件子任务由于意外没有完成需要重新排期or措施

# ChronoAgent 前端全局开发规范 Skill

你是一个资深 React + TypeScript 前端工程师。接下来你需要参与开发一个 PC 端智能时间管理 Agent 平台。请在所有代码生成、组件设计、样式实现和重构建议中遵守以下全局规范。

## 一、整体开发原则

1. 优先保证代码可维护、可扩展、可读，而不是只追求一次性跑通。
2. 不要把所有逻辑堆在单个页面文件中，必须按业务模块合理拆分组件。
3. 页面级组件只负责布局和数据编排，复杂 UI 和业务交互应下沉到 feature 组件中。
4. 公共 UI、工具函数、类型定义、接口请求、状态管理必须独立抽离。
5. 避免重复代码。如果同类 UI 或逻辑出现两次以上，应考虑封装组件或 hook。
6. 组件命名要清晰表达职责，例如 `CalendarMain`、`EventModal`、`AgentRunTimeli ne`、`PlanPreview`。
7. 不要为了抽象而抽象。只有当复用、可读性或职责边界明显收益时才抽象。

## 二、响应式布局要求

1. 所有页面必须具备基础响应式能力，至少适配：
   - `1440px` 及以上桌面屏
   - `1280px` 普通笔记本
   - `1024px` 小屏笔记本 / 平板横屏
   - `768px` 平板宽度
2. 不要大量使用固定 `px` 宽高。优先使用：
   - `flex`
   - `grid`
   - `minmax`
   - `clamp`
   - `rem`
   - `%`
   - `calc()`
   - `min-width / max-width`
   - `min-height / max-height`
3. 必须避免内容溢出、文字重叠、按钮挤压、面板超出屏幕。
4. 主布局应使用弹性布局：
   - Sidebar 可以固定宽度，但需要在小屏下可折叠。
   - 右侧 AI 面板在宽屏下固定展示，在小屏下可收起或移动到下方。
   - 日历主体必须优先获得最大可用空间。
5. 不要使用大量硬编码高度。涉及视口高度时，可以使用：
   - `height: 100vh`
   - `height: calc(100vh - var(--header-height))`
   - `min-height: 0`
   - `overflow: hidden / auto`
6. 长列表、时间线、右侧面板内容必须使用内部滚动，不要让整个页面无控制地滚动。

## 三、样式规范

1. 项目使用 Ant Design 作为基础组件库，优先使用其 `Layout`、`Form`、`Modal`、`Drawer`、`Button`、`Tag`、`Timeline`、`List`、`Card`、`Alert`、`Segmented` 等组件。
2. 日历主体使用 FullCalendar，不使用 Ant Design Calendar 作为主日历。
3. 样式可以使用 CSS Modules、普通 CSS 或 Ant Design theme token，但不要写成混乱的内联样式。
4. 少写固定 `px`。必要的固定尺寸可以用于：
   - Sidebar 宽度
   - Header 高度
   - 右侧面板最大 / 最小宽度
   - 图标尺寸
5. 圆角、间距、颜色要统一，建议使用 CSS 变量或 theme token。
6. 视觉风格保持专业、克制、清爽，类似 SaaS 工作台。
7. 不要使用大面积渐变背景、营销型 hero、花哨动画或过度装饰。
8. 不要出现卡片套卡片过多的情况。只有信息分组明确时才使用 Card。
9. 颜色语义要稳定：
   - 主色用于主要操作。
   - 红色用于危险和高优先级。
   - 橙色用于警告和中优先级。
   - 绿色用于成功和生活分类。
   - 蓝色用于工作和主操作。

## 四、组件拆分规范

请按以下层级组织组件：

### 1. `pages`

- 页面级组件。
- 负责页面路由、整体布局、聚合 feature 模块。
- 不直接写复杂表单和业务细节。

### 2. `layouts`

- `AppLayout`
- `Sidebar`
- `Topbar`
- 页面骨架相关组件。

### 3. `features`

按业务模块拆分：

- `calendar`
- `agent`
- `auth`
- `task`

### 4. `components`

只放真正通用的基础组件，例如：

- `EmptyState`
- `PageHeader`
- `StatusTag`
- `ConfirmButton`

### 5. `hooks`

抽离可复用交互逻辑，例如：

- `useCalendarEvents`
- `useAgentRun`
- `useAuth`

### 6. `services`

- 所有 API 请求统一放这里。
- 页面和组件不能直接写 `fetch` / `axios`。

### 7. `stores`

Zustand 状态管理，按业务拆分：

- `authStore`
- `calendarStore`
- `agentStore`

### 8. `types`

统一放 TypeScript 类型：

- `Event`
- `Task`
- `AgentRun`
- `AgentStep`
- `User`

## 五、状态管理规范

1. 本项目使用 Zustand + Immer。
2. 只把跨组件共享状态放入 Zustand。
3. 表单内部临时状态优先交给 Ant Design Form 或组件局部 state。
4. 服务端数据优先使用 TanStack Query 管理。
5. Zustand 负责：
   - 当前日历视图
   - 当前日期
   - 当前选中的日程
   - Modal / Drawer 打开状态
   - 当前 Agent Run 状态
   - 当前排期方案
6. 不要把接口返回的大量列表无脑塞进 Zustand。服务端数据应交给 Query 缓存。
7. 状态命名要清晰，避免 `data`、`list`、`info` 这种泛化命名。

## 六、接口与数据层规范

1. 所有接口调用必须经过 `services` 层。
2. `services` 层返回结构化数据，不要在组件里拼装复杂请求。
3. API 类型要和业务类型分离，必要时定义 DTO。
4. 组件中不直接处理复杂数据转换，复杂转换放到 `utils` 或 `adapter`。
5. 所有异步操作必须考虑：
   - `loading`
   - `error`
   - `empty`
   - `success feedback`
6. 删除、确认写入、批量操作等危险动作必须有二次确认。

## 七、Agent 相关 UI 规范

1. AI 不应该直接修改用户日程，必须经过用户确认。
2. Agent 执行过程必须可视化，至少包括：
   - 解析用户输入
   - 拆解任务
   - 查询日历
   - 计算空闲时间
   - 生成排期方案
   - 检测冲突
   - 等待用户确认
   - 执行写入日历
3. 每个步骤应有状态：
   - `pending`
   - `running`
   - `success`
   - `failed`
4. Agent 生成的方案必须以结构化卡片或列表展示，不能只展示一段自然语言。
5. 用户可以：
   - 确认方案
   - 拒绝方案
   - 输入修改意见重新生成
   - 取消本次 Agent Run
6. Agent Run 详情可以用 Drawer 展示，包含：
   - `runId`
   - 节点输入
   - 节点输出
   - 错误信息
   - 执行时间

## 八、表单规范

1. 日程表单必须包含：
   - 标题
   - 开始时间
   - 结束时间
   - 地点
   - 分类
   - 优先级
   - 备注
   - 状态
2. 必须校验：
   - 标题不能为空。
   - 开始时间必须早于结束时间。
   - 必填字段不能为空。
3. 编辑和新建尽量复用同一个 `EventForm`。
4. 表单提交期间按钮进入 `loading` 状态。
5. 提交失败时给出明确错误提示。
6. 编辑态才展示删除按钮。

## 九、可访问性与用户体验

1. 可点击元素必须有明确 `hover` / `active` / `disabled` 状态。
2. 危险操作使用 `Popconfirm` 或 `Modal` 二次确认。
3. 图标按钮需要 `Tooltip`。
4. 空状态要有说明和行动按钮。
5. 错误提示要告诉用户发生了什么，而不是只显示 `Error`。
6. `loading` 状态不要让用户误以为页面卡死。
7. 禁用状态要清晰，例如 Agent 正在执行时禁用重复提交。

## 十、代码质量要求

1. TypeScript 类型必须明确，避免 `any`。
2. 组件 props 必须定义 `interface` / `type`。
3. 函数职责要单一，避免超长函数。
4. 文件不要过长。单个组件文件如果超过 `250` 行，应考虑拆分。
5. 不要写无意义注释。只在复杂逻辑前写简短解释。
6. `import` 顺序保持清晰：
   - React / 第三方库
   - 项目内部模块
   - 样式文件
7. 不要在组件中写大量 mock 数据。mock 数据应放在 `mocks` 或 `services/mock` 中。
8. 生成代码后请检查：
   - 是否有未使用变量
   - 是否有类型错误
   - 是否有重复组件
   - 是否有明显样式溢出
   - 是否有逻辑堆叠

## 十一、项目推荐目录结构

```text
src/
  app/
    App.tsx
    router.tsx
    providers.tsx

  layouts/
    AppLayout.tsx
    Sidebar.tsx
    Topbar.tsx

  pages/
    LoginPage.tsx
    CalendarWorkspacePage.tsx
    AgentRunsPage.tsx

  features/
    auth/
      LoginForm.tsx
      RegisterForm.tsx
      AuthGuard.tsx

    calendar/
      CalendarMain.tsx
      CalendarToolbar.tsx
      EventModal.tsx
      EventForm.tsx
      TodayAgenda.tsx
      ConflictAlert.tsx

    agent/
      AIAssistantPanel.tsx
      AgentRunTimeline.tsx
      PlanPreview.tsx
      AgentRunDrawer.tsx
      AgentRunHistory.tsx

  components/
    EmptyState.tsx
    StatusTag.tsx
    PriorityTag.tsx

  hooks/
    useCalendarEvents.ts
    useAgentRun.ts

  services/
    authApi.ts
    eventApi.ts
    agentApi.ts

  stores/
    authStore.ts
    calendarStore.ts
    agentStore.ts

  types/
    auth.ts
    event.ts
    agent.ts

  utils/
    date.ts
    format.ts
# 压缩机制说明

这个目录里的压缩逻辑已经从 `agent-main-flow.ts` 拆到 `session-compression.ts`。

## 入口

- 手动压缩：用户输入 `/compact` 或 `/compat`
- 自动压缩：新消息进入后，如果会话估算 token 过高
- 轻量压缩：长时间无活动后，下一次交互前先做一次微压缩

## 触发时机

- `AUTO_COMPACT_TRIGGER_TOKENS = 7500`：超过后允许自动压缩
- `AUTO_COMPACT_WARN_TOKENS = 6000`：只记录告警
- `AUTO_COMPACT_HARD_LIMIT_TOKENS = 9000`：只记录更强告警
- `AUTO_COMPACT_COOLDOWN_MS = 90s`：刚压缩过就不重复压缩
- `MICRO_COMPACT_IDLE_MS = 1h`：空闲超过 1 小时，下一次进入流程前做微压缩

## 压缩方式

- 先把当前会话打成 snapshot
- 调用 DeepSeek 生成结构化摘要
- 要求保留：
  - 当前目标
  - 截止时间
  - 预计耗时
  - 偏好
  - 缺失字段
  - 方案卡
  - 用户选择
  - 批注
  - 冲突记录
  - 下一步动作
  - 当前执行状态
- 要求删除：
  - 重复对话
  - 过时中间推理
  - 已摘要的原始日志

## 重写结果

压缩完成后，旧会话会被替换成新的单条 system 记忆消息，再按模式决定是否保留：

- 最近消息
- 最近工具结果

auto/manual 会保留最近 25 条工具结果，micro 会保留最近 5 条工具结果。
更早的工具结果不会直接消失，而是会折叠成一个 `tool_result_placeholder` 占位符，保留“这里曾经有工具调用”的痕迹。
micro 还会额外保留少量最近消息，其余模式默认只保留摘要后的记忆。

这里的设计更接近 Claude Code 的服务端压缩思路：先生成压缩后的上下文摘要，再由后端决定如何重写 session。
压缩器本身仍然是 TS 里的确定性状态重写逻辑，LLM 只负责生成摘要文本，不负责决定状态如何裁剪。

## 代码入口

- `session-compression.ts`
- `agent-main-flow.ts`

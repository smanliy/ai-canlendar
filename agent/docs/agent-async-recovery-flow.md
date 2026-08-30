# Agent Async Recovery Flow

```mermaid
flowchart TD
    sync["当前工作台默认流程<br/>POST /api/agent/runs 或 /runs/stream<br/>同步 / SSE，不进 AgentJob"]

    createJob["异步任务入口<br/>POST /api/agent/jobs<br/>createScheduleJob()<br/>返回 202 queued"]
    jobTable[("AgentJob<br/>runId / type / status<br/>attempt / maxAttempts<br/>lockedAt / heartbeatAt<br/>idempotencyKey")]

    worker["后台 worker<br/>startAgentJobWorker()<br/>每 1.2s 轮询"]
    claim["claimNextAgentJob()<br/>FOR UPDATE SKIP LOCKED<br/>queued -> running"]
    mainFlow["runAgentMainFlow()<br/>排期生成 / 冲突处理 / 方案调整"]
    eventTable[("AgentJobEvent<br/>step:start / step:success / step:failed<br/>payload / durationMs")]

    waiting{"结果需要用户继续?"}
    checkpoint["createWaitingCheckpoint()<br/>Agent 挂起<br/>job.status = waiting_user"]
    checkpointTable[("AgentCheckpoint<br/>type / stepName / prompt<br/>resumePayload / stateSnapshot<br/>version / expiresAt / status")]

    decisionJob["用户继续确认<br/>POST /api/agent/runs/:runId/decision/jobs<br/>resolveCheckpoint()<br/>创建 resume_decision job"]
    rollback["状态回滚<br/>POST /api/agent/runs/:runId/rollback<br/>恢复 planningSession<br/>创建新的 checkpoint"]

    success["任务完成<br/>job.status = succeeded"]
    retry["异常重试<br/>failAgentJob()<br/>attempt < maxAttempts 时重新 queued"]
    stale["心跳超时恢复<br/>recoverStaleAgentJobs()<br/>stale running 重新 queued 或 failed"]

    calendar[("CalendarEvent<br/>source = agent<br/>agentRunId = runId")]
    undo["撤销 Agent 写入<br/>POST /api/events/agent-runs/latest/undo<br/>或 /agent-runs/:runId/undo"]
    compensation[("AgentCompensation<br/>type = undo_agent_calendar_events<br/>affectedCount / reason / payload")]

    createJob --> jobTable
    jobTable --> worker --> claim --> mainFlow
    mainFlow --> eventTable
    mainFlow --> waiting
    waiting -->|是| checkpoint --> checkpointTable
    waiting -->|否| success
    checkpointTable --> decisionJob --> jobTable
    checkpointTable --> rollback --> checkpointTable
    mainFlow -.异常.-> retry --> jobTable
    worker -.heartbeat 超时.-> stale --> jobTable
    success --> calendar --> undo --> compensation

    sync -.对照说明.-> createJob
```

## 验收参照物

- `AgentJob.status` 应该能从 `queued` 变为 `running`，最终变为 `waiting_user`、`succeeded`、`failed` 或 `canceled`。
- `AgentCheckpoint.status` 在等待用户确认时是 `pending`，用户继续时会被 `resolveCheckpoint()` 标成 `resolved`。
- `AgentJobEvent` 应该记录每个后台步骤，比如 `job:running`、`step:start`、`step:success`、`job:waiting_user`。
- `CalendarEvent.source = agent` 且 `agentRunId` 有值时，说明日程来自 Agent 写入。
- 撤销后 `CalendarEvent.deletedAt` 会被填上，`AgentCompensation` 会新增一条补偿记录。
```

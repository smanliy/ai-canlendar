import os from "os";

import {
  applyPlanAnnotation,
  resumeScheduleDecision,
} from "./agent.orchestrator";
import { runAgentMainFlow, type AgentMainFlowEvent } from "./agent-main-flow";
import type {
  AgentAnnotationPayload,
  AgentDecisionPayload,
} from "./agent.schema";
import type {
  AgentAnnotationResponse,
  AgentCreateRunResponse,
  AgentDecisionResponse,
} from "./agent.types";
import { createCheckpoint } from "./agent-checkpoint.repository";
import { findPlanningSession } from "./agent-planning-session.repository";
import {
  appendMessage,
  estimateSessionTokens,
  getCompressionSettings,
  getSession,
  recordAgentTurnContinuationTokenMetric,
} from "./session-compression";
import {
  appendAgentJobEvent,
  claimNextAgentJob,
  completeAgentJob,
  cancelAgentJobById,
  failAgentJob,
  findAgentJob,
  heartbeatAgentJob,
  recoverStaleAgentJobs,
  touchAgentJobProgress,
  updateAgentJobRunId,
  type AgentJobRecord,
} from "./agent-job.repository";
import { reapOrphanAgentJobs } from "./agent.abort";
import { expirePendingCheckpoints } from "./agent-checkpoint.repository";

const WORKER_POLL_MS = 1200;
const CHECKPOINT_TTL_MS = 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 10 * 1000;
const HEARTBEAT_STALE_MS = 30 * 1000;
const PROGRESS_STALE_MS = 5 * 60 * 1000;

let workerStarted = false;
let workerTimer: NodeJS.Timeout | null = null;
const workerId = `${os.hostname()}-${process.pid}`;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordFollowupTokenMetric(
  userId: string,
  input: {
    runId: string;
    phase: string;
    userText: string;
    assistantText: string;
    result: unknown;
  },
) {
  const state = getSession(userId);
  const contextTokensBefore = estimateSessionTokens(state);
  appendMessage(state, "user", input.userText);
  appendMessage(state, "assistant", input.assistantText);
  state.agentState = input.result;
  state.toolResults.push(input.result);
  recordAgentTurnContinuationTokenMetric(userId, {
    runId: input.runId,
    status: "waitingConfirm",
    phase: input.phase,
    compressionEnabled: getCompressionSettings(userId).enabled,
    contextTokensBefore,
    state,
    result: input.result,
  });
}

function eventName(event: AgentMainFlowEvent): string {
  if (event.type === "stepStarted") return "step:start";
  if (event.type === "stepUpdated") return "step:update";
  if (event.type === "stepSucceeded") return "step:success";
  if (event.type === "stepFailed") return "step:failed";
  if (event.type === "directAnswer") return "direct:answer";
  if (event.type === "commandResult") return "command:result";
  return "final";
}

async function persistMainFlowEvent(
  jobId: string,
  event: AgentMainFlowEvent,
): Promise<void> {
  await heartbeatAgentJob(jobId, workerId);
  //更新业务进度的时间戳
  await touchAgentJobProgress(jobId, workerId);
  const stepId = "stepId" in event ? event.stepId : undefined;
  const message =
    "message" in event && typeof event.message === "string"
      ? event.message
      : undefined;
  const level =
    event.type === "stepFailed"
      ? "error"
      : event.type === "stepUpdated"
        ? "info"
        : "info";
  await appendAgentJobEvent({
    jobId,
    type: eventName(event),
    stepId,
    message,
    payload: event,
    level,
  });
}

function readToolStatus(value: unknown): string {
  const status = readObject(value).status;
  return typeof status === "string" ? status : "";
}

function buildCheckpointPrompt(
  result: AgentCreateRunResponse | AgentDecisionResponse,
): string {
  if (result.status === "needsUserInput") return result.message;
  if (result.status === "needsConflictResolution") return result.message;
  if (result.status !== "waitingConfirm") return "Agent 等待用户继续处理。";
  if (result.plans.length > 0)
    return "已生成候选排期方案，等待用户选择并确认。";

  const scheduleInterrupt = readObject(result.scheduleToolResult).interrupt;
  const conflictStatus = readToolStatus(result.conflictCheckResult);
  if (scheduleInterrupt) return "排期过程中需要用户确认处理方式。";
  if (conflictStatus === "needsDecision" || conflictStatus === "pending")
    return "检测到冲突或冲突检测待确认，等待用户处理。";
  return "当前排期需要用户确认下一步处理方式。";
}

function buildCheckpointType(
  result: AgentCreateRunResponse | AgentDecisionResponse,
) {
  if (result.status === "needsUserInput") return "required_fields" as const;
  if (result.status === "needsConflictResolution") return "conflict_decision" as const;
  if (result.status !== "waitingConfirm") return "schedule_decision" as const;
  if (result.plans.length > 0) return "final_confirm" as const;

  const conflictStatus = readToolStatus(result.conflictCheckResult);
  if (conflictStatus === "needsDecision" || conflictStatus === "pending")
    return "conflict_decision" as const;
  return "schedule_decision" as const;
}

async function createWaitingCheckpoint(
  job: AgentJobRecord,
  result: AgentCreateRunResponse | AgentDecisionResponse,
): Promise<void> {
  if (
    result.status !== "waitingConfirm" &&
    result.status !== "needsUserInput" &&
    result.status !== "needsConflictResolution"
  )
    return;
  const planningSession = await findPlanningSession(result.runId, job.userId);

  // waiting_user 的断点永不过期（需求 R3：需要用户决策的节点永远保留）。
  // 注意这里不传 expiresAt，expireIdleCheckpoints 只清理带过期时间的断点。
  const checkpoint = await createCheckpoint({
    runId: result.runId,
    userId: job.userId,
    jobId: job.id,
    type: buildCheckpointType(result),
    stepName:
      result.status === "needsUserInput"
        ? "required_fields"
        : "user_confirmation",
    prompt: buildCheckpointPrompt(result),
      options:
        result.status === "waitingConfirm"
          ? (readObject(result.scheduleToolResult).interrupt ?? result.plans)
          : result.status === "needsUserInput"
            ? result.clarificationJson
            : {
                conflicts: result.conflicts,
                pendingOperation: result.pendingOperation,
                suggestedShiftMinutes: result.suggestedShiftMinutes,
              },
    resumePayload: {
      jobType: job.type,
      runId: result.runId,
      sourceJobId: job.id,
    },
    stateSnapshot: {
      result,
      planningSession,
    }
  });

  await appendAgentJobEvent({
    jobId: job.id,
    type: "checkpoint:created",
    message: checkpoint.prompt,
    payload: checkpoint,
  });
}

async function executeSchedulePlanJob(
  job: AgentJobRecord,
): Promise<AgentCreateRunResponse> {
  const input = readObject(job.input);
  const userInput = typeof input.input === "string" ? input.input : "";
  if (!userInput.trim()) throw new Error("AgentJob input is missing input");

  return runAgentMainFlow({
    userId: job.userId,
    input: userInput,
    clarificationJson: input.clarificationJson,
    onEvent(event) {
      return persistMainFlowEvent(job.id, event);
    },
  });
}

async function executeResumeDecisionJob(
  job: AgentJobRecord,
): Promise<AgentDecisionResponse> {
  const input = readObject(job.input);
  const runId = typeof input.runId === "string" ? input.runId : job.runId;
  const decision = readObject(
    input.decision,
  ) as unknown as AgentDecisionPayload;
  const sourceJobId =
    typeof input.sourceJobId === "string" ? input.sourceJobId.trim() : "";
  if (!decision.optionId || !decision.taskId)
    throw new Error("AgentJob decision payload is incomplete");

  await appendAgentJobEvent({
    jobId: job.id,
    type: "step:start",
    stepId: "resume",
    message: "正在根据用户决策恢复 Agent 排期",
  });
  const result = await resumeScheduleDecision(job.userId, runId, decision);
  if (sourceJobId) {
    await completeAgentJob(sourceJobId, result, "succeeded");
  }
  recordFollowupTokenMetric(job.userId, {
    runId,
    phase: "resumeDecision",
    userText: `用户选择排期决策：${JSON.stringify(decision)}`,
    assistantText:
      result.plans.length > 0
        ? `已根据选择更新 ${result.plans.length} 个方案。`
        : "已根据选择继续恢复排期，仍需确认。",
    result,
  });
  await appendAgentJobEvent({
    jobId: job.id,
    type: "step:success",
    stepId: "resume",
    message:
      result.plans.length > 0
        ? "恢复完成，已生成新的候选方案"
        : "恢复完成，仍需用户继续确认",
    payload: result,
  });
  return result;
}

async function executeAnnotationJob(
  job: AgentJobRecord,
): Promise<AgentAnnotationResponse> {
  const input = readObject(job.input);
  const runId = typeof input.runId === "string" ? input.runId : job.runId;
  const annotation = readObject(
    input.annotation,
  ) as unknown as AgentAnnotationPayload;
  await appendAgentJobEvent({
    jobId: job.id,
    type: "step:start",
    stepId: "annotation",
    message: "正在根据批注更新方案卡",
  });
  const result = await applyPlanAnnotation(job.userId, runId, annotation);
  recordFollowupTokenMetric(job.userId, {
    runId,
    phase: "planAnnotation",
    userText: `用户批注方案：${JSON.stringify(annotation)}`,
    assistantText: "已根据批注更新方案卡。",
    result,
  });
  await appendAgentJobEvent({
    jobId: job.id,
    type: "step:success",
    stepId: "annotation",
    message: "批注更新完成",
    payload: result,
  });
  return result;
}
//执行agent主函数
async function executeJob(job: AgentJobRecord): Promise<unknown> {
  const startedAt = Date.now();

  //执行一次心跳
  await heartbeatAgentJob(job.id, workerId);
  //刷新业务进度函数
  await touchAgentJobProgress(job.id, workerId);
  //写入事件日志
  await appendAgentJobEvent({
    jobId: job.id,
    type: "job:running",
    message: `Agent job ${job.type} started`,
    payload: { jobId: job.id, runId: job.runId, attempt: job.attempt },
  });

  if (job.type === "schedule_plan") {
    const result = await executeSchedulePlanJob(job);
    await heartbeatAgentJob(job.id, workerId);
    await appendAgentJobEvent({
      jobId: job.id,
      type: "job:duration",
      durationMs: Date.now() - startedAt,
    });
    return result;
  }
  if (job.type === "resume_decision") {
    const result = await executeResumeDecisionJob(job);
    await heartbeatAgentJob(job.id, workerId);
    await appendAgentJobEvent({
      jobId: job.id,
      type: "job:duration",
      durationMs: Date.now() - startedAt,
    });
    return result;
  }
  if (job.type === "annotate_plan") {
    const result = await executeAnnotationJob(job);
    await heartbeatAgentJob(job.id, workerId);
    await appendAgentJobEvent({
      jobId: job.id,
      type: "job:duration",
      durationMs: Date.now() - startedAt,
    });
    return result;
  }
  throw new Error(`Unsupported Agent job type: ${job.type}`);
}
//为每个running任务启动独立stetniterval ,每10s调用
function startJobHeartbeat(jobId: string): NodeJS.Timeout {
  return setInterval(() => {
    heartbeatAgentJob(jobId, workerId).catch((error) => {
      console.error("[AgentJobWorker] heartbeat failed:", error);
    });
  }, HEARTBEAT_INTERVAL_MS);
}

async function expireIdleCheckpoints(): Promise<void> {
  const expired = await expirePendingCheckpoints(
    new Date(Date.now() - CHECKPOINT_TTL_MS),
  );
  for (const checkpoint of expired) {
    if (!checkpoint.jobId) continue;
    await cancelAgentJobById(checkpoint.jobId);
    await appendAgentJobEvent({
      jobId: checkpoint.jobId,
      type: "job:canceled",
      message: "确认节点超过 1 小时未恢复，任务已自动取消",
      payload: {
        checkpointId: checkpoint.id,
        reason: "checkpoint_expired",
      },
      level: "warn",
    });
  }
}

async function tick(): Promise<void> {
  // 孤儿任务回收（内部 60 秒节流）：清理 beacon 没发出来的异常退出任务
  await reapOrphanAgentJobs();

  const recovered = await recoverStaleAgentJobs({
    heartbeatStaleBefore: new Date(Date.now() - HEARTBEAT_STALE_MS),
    progressStaleBefore: new Date(Date.now() - PROGRESS_STALE_MS),
  });
  if (recovered.total > 0) {
    console.warn("[AgentJobWorker] recovered stale jobs", { recovered });
  }
  await expireIdleCheckpoints();
  const job = await claimNextAgentJob(workerId);
  if (!job) return;

  const heartbeatTimer = startJobHeartbeat(job.id);
  try {
    const result = await executeJob(job);
    const resultRunId = readObject(result).runId;
    if (
      typeof resultRunId === "string" &&
      resultRunId &&
      resultRunId !== job.runId
    ) {
      await updateAgentJobRunId(job.id, resultRunId);
      job.runId = resultRunId;
    }
    const status =
      readObject(result).status === "waitingConfirm" ||
      readObject(result).status === "needsUserInput" ||
      readObject(result).status === "needsConflictResolution"
        ? "waiting_user"
        : "succeeded";
    if (status === "waiting_user") {
      await createWaitingCheckpoint(
        job,
        result as AgentCreateRunResponse | AgentDecisionResponse,
      );
    }
    const completed = await completeAgentJob(job.id, result, status);
    if (completed === 0) {
      const currentJob = await findAgentJob(job.id, job.userId);
      if (!currentJob || currentJob?.status === "canceled") return;
    }
    await appendAgentJobEvent({
      jobId: job.id,
      type: status === "waiting_user" ? "job:waiting_user" : "job:succeeded",
      message:
        status === "waiting_user"
          ? "Agent 已挂起并等待用户确认"
          : "Agent job completed",
      payload: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent job failed";
    await failAgentJob(job, message);
    // 任务可能已被异常退出清理物理删除：写失败事件前确认任务还存在
    const stillExists = await findAgentJob(job.id, job.userId);
    if (stillExists) {
      await appendAgentJobEvent({
        jobId: job.id,
        type: "job:failed",
        message,
        payload: { error: message },
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function scheduleNextTick(): void {
  workerTimer = setTimeout(() => {
    tick()
      .catch((error) => {
        console.error("[AgentJobWorker] tick failed:", error);
      })
      .finally(scheduleNextTick);
  }, WORKER_POLL_MS);
}

export function startAgentJobWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  console.log(`[AgentJobWorker] started workerId=${workerId}`);
  scheduleNextTick();
}

export function stopAgentJobWorker(): void {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  workerStarted = false;
}

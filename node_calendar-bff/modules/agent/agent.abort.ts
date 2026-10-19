import * as jobRepository from './agent-job.repository';
import { AgentJobNotFoundError } from './agent.errors';

/**
 * 异常退出清理模块。
 *
 * 职责：
 * 1. SSE 订阅者注册表——判断"任务还有人看吗"；
 * 2. beacon abort 请求——收到信号后延迟 30 秒再物理删除，
 *    期间 SSE 重新有订阅者（用户手滑刷新后重连）则取消删除；
 * 3. 孤儿任务回收——beacon 没发出来（崩溃/断网）时的兜底。
 *
 * 注意：本模块只允许清理 queued/running 任务。
 * waiting_user（需要用户决策，永远保留）与 paused_manual（手动终止断点）不受影响。
 */

const ABORT_GRACE_MS = 30 * 1000;
const REAPER_STALE_MS = 3 * 60 * 1000;
const REAPER_INTERVAL_MS = 60 * 1000;

/** jobId -> 订阅中的 tabId 集合（单实例 BFF 内存态） */
const sseSubscribers = new Map<string, Set<string>>();

/** jobId -> 待执行的延迟删除 */
interface PendingAbort {
  jobId: string;
  userId: string;
  timer: NodeJS.Timeout;
}
const pendingAborts = new Map<string, PendingAbort>();

let lastReapAt = 0;

export function registerSseSubscriber(jobId: string, tabId: string): void {
  let tabs = sseSubscribers.get(jobId);
  if (!tabs) {
    tabs = new Set();
    sseSubscribers.set(jobId, tabs);
  }
  tabs.add(tabId);

  // 重连即取消待执行的异常退出删除（手滑刷新场景）
  const pending = pendingAborts.get(jobId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingAborts.delete(jobId);
    console.warn('[AgentAbort] pending abort canceled, SSE resubscribed', { jobId, tabId });
  }
}

export function unregisterSseSubscriber(jobId: string, tabId: string): void {
  const tabs = sseSubscribers.get(jobId);
  if (!tabs) return;
  tabs.delete(tabId);
  if (tabs.size === 0) sseSubscribers.delete(jobId);
}

export function hasSseSubscribers(jobId: string): boolean {
  return (sseSubscribers.get(jobId)?.size ?? 0) > 0;
}

async function hardDeleteWithLog(jobId: string, userId: string, reason: string): Promise<boolean> {
  const deleted = await jobRepository.hardDeleteAgentJob(jobId, userId);
  if (deleted) {
    console.warn('[AgentAbort] job hard deleted', { jobId, userId, reason });
  }
  return deleted;
}

/**
 * beacon 信号入口：标记 30 秒后物理删除。
 * 30 秒内该 job 的 SSE 重新有订阅者 → 取消删除（刷新误杀防护）。
 */
export async function requestAbortJob(input: { userId: string; jobId: string; reason?: string }): Promise<{ abortScheduled: true; graceMs: number }> {
  const job = await jobRepository.findAgentJob(input.jobId, input.userId);
  if (!job) throw new AgentJobNotFoundError();
  if (!['queued', 'running'].includes(job.status)) {
    // waiting_user / paused_manual / 终态任务不做物理删除
    throw new AgentJobNotFoundError(`任务当前状态为 ${job.status}，不适用异常退出清理`);
  }

  if (pendingAborts.has(input.jobId)) {
    return { abortScheduled: true, graceMs: ABORT_GRACE_MS };
  }

  const timer = setTimeout(() => {
    pendingAborts.delete(input.jobId);
    // 延迟期结束时再看一眼：有订阅者就不删（多标签页场景）
    if (hasSseSubscribers(input.jobId)) {
      console.warn('[AgentAbort] abort skipped, job still has SSE subscribers', { jobId: input.jobId });
      return;
    }
    void hardDeleteWithLog(input.jobId, input.userId, input.reason ?? 'abnormal_exit').catch((error) => {
      console.error('[AgentAbort] delayed hard delete failed:', error);
    });
  }, ABORT_GRACE_MS);

  pendingAborts.set(input.jobId, { jobId: input.jobId, userId: input.userId, timer });
  return { abortScheduled: true, graceMs: ABORT_GRACE_MS };
}

/**
 * 孤儿任务回收器（worker 每 tick 调用，内部按 60 秒节流）：
 * running/queued + 心跳停摆超 3 分钟 + 无 SSE 订阅者 + 不在删除宽限期内 → 物理删除。
 * 覆盖 beacon 没发出来的场景（浏览器崩溃、进程被杀、断网）。
 */
export async function reapOrphanAgentJobs(): Promise<number> {
  const now = Date.now();
  if (now - lastReapAt < REAPER_INTERVAL_MS) return 0;
  lastReapAt = now;

  const staleBefore = new Date(now - REAPER_STALE_MS);
  const staleJobs = await jobRepository.findStaleActiveAgentJobs(staleBefore);

  let deleted = 0;
  for (const job of staleJobs) {
    if (pendingAborts.has(job.id)) continue;
    if (hasSseSubscribers(job.id)) continue;
    const ok = await hardDeleteWithLog(job.id, job.userId, 'orphan_reaper').catch(() => false);
    if (ok) deleted += 1;
  }
  if (deleted > 0) {
    console.warn('[AgentAbort] reaper deleted orphan jobs', { deleted });
  }
  return deleted;
}

export function cancelPendingAbortForJob(jobId: string): void {
  const pending = pendingAborts.get(jobId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingAborts.delete(jobId);
  }
}

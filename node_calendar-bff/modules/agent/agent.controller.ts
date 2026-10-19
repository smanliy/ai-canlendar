import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import * as agentService from './agent.service';
import { getAgentHttpStatus } from './agent.errors';
import { requestAbortJob } from './agent.abort';
import { validateAgentAnnotationPayload, validateAgentConversationMessagePayload, validateAgentDecisionPayload, validateAgentEventConflictResolutionPayload, validateAgentEventSelectionPayload, validateAgentRollbackPayload, validateCreateAgentRunPayload } from './agent.schema';
import * as eventService from '../events/events.service';
import { prisma } from '../db/prisma';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * beacon 端点自带的 JWT 校验（等价于 requireAuth，但 token 从 body 取）。
 * 返回 userId，校验失败返回 null。
 */
async function verifyBeaconToken(token: string): Promise<string | null> {
  try {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) return null;
    const decoded = jwt.verify(token, secret);
    if (!decoded || typeof decoded === 'string' || typeof decoded.sub !== 'string') return null;
    const user = await prisma.user.findUnique({
      where: { id: (decoded as { sub: string }).sub },
      select: { id: true, status: true }
    });
    if (!user || user.status !== 'active') return null;
    return user.id;
  } catch {
    return null;
  }
}

export async function getCompressionSettings(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    res.status(200).json({
      code: 0,
      message: 'ok',
      data: await agentService.getCompressionSettings(req.user.id)
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询压缩设置失败'),
      data: null
    });
  }
}

export async function updateCompressionSettings(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be boolean');
    }

    res.status(200).json({
      code: 0,
      message: 'ok',
      data: await agentService.updateCompressionSettings(req.user.id, { enabled })
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '更新压缩设置失败'),
      data: null
    });
  }
}

export async function getTokenMetrics(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    res.status(200).json({
      code: 0,
      message: 'ok',
      data: await agentService.getTokenMetrics(req.user.id)
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询 Token 指标失败'),
      data: null
    });
  }
}

export async function createRun(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const payload = validateCreateAgentRunPayload(req.body);
    console.log('[Node Agent API] POST /api/agent/runs received:', {
      userId: req.user.id,
      input: payload.input
    });
    const data = await agentService.createScheduleRun(req.user.id, payload.input, payload.clarificationJson);

    res.status(201).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    console.error('[Node Agent API] POST /api/agent/runs failed:', {
      statusCode,
      message: getErrorMessage(error, 'Agent failed'),
      error
    });
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, 'Agent failed'),
      data: null
    });
  }
}

export async function createJob(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const payload = validateCreateAgentRunPayload(req.body);
    const data = await agentService.createScheduleJob(req.user.id, payload.input, payload.clarificationJson, payload.forceNew ?? false);

    res.status(202).json({
      code: 0,
      message: 'queued',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '创建 Agent 异步任务失败'),
      data: null
    });
  }
}

export async function listJobs(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const data = await agentService.listScheduleJobs(req.user.id);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询 Agent 任务失败'),
      data: null
    });
  }
}

export async function getJob(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) throw new Error('jobId is required');
    const data = await agentService.getScheduleJob(req.user.id, jobId);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询 Agent 任务失败'),
      data: null
    });
  }
}

export async function listJobEvents(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) throw new Error('jobId is required');
    const data = await agentService.listScheduleJobEvents(req.user.id, jobId);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询 Agent 任务事件失败'),
      data: null
    });
  }
}

export async function cancelJob(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) throw new Error('jobId is required');
    const data = await agentService.cancelScheduleJob(req.user.id, jobId);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '取消 Agent 任务失败'),
      data: null
    });
  }
}

export async function createDecisionJob(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }
    const runId = String(req.params.runId || '').trim();
    if (!runId) throw new Error('runId is required');
    const decision = validateAgentDecisionPayload(req.body);
    const data = await agentService.createScheduleDecisionJob(req.user.id, runId, decision);
    res.status(202).json({
      code: 0,
      message: 'queued',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '创建 Agent 恢复任务失败'),
      data: null
    });
  }
}

export async function rollbackRun(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }
    const runId = String(req.params.runId || '').trim();
    if (!runId) throw new Error('runId is required');
    const payload = validateAgentRollbackPayload(req.body);
    const data = await agentService.rollbackScheduleRun(req.user.id, runId, payload);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, 'Agent 状态回滚失败'),
      data: null
    });
  }
}

/**
 * 用户在选项框里点定某条日程后回传：带着 eventId 重跑该改/删操作。
 * body: { eventId: string, operation: { kind, target?, patch? } }
 */
export async function resolveEventSelection(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }
    const payload = validateAgentEventSelectionPayload(req.body);
    const data = await agentService.resolveEventSelection(req.user.id, payload);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
    } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '日程选择执行失败'),
      data: null
    });
  }
}

export async function resolveEventConflict(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }
    const payload = validateAgentEventConflictResolutionPayload(req.body);
    const data = await agentService.resolveEventConflict(req.user.id, payload);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '时间冲突决策执行失败'),
      data: null
    });
  }
}

export async function submitDecision(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }
    const runId = String(req.params.runId || '').trim();
    if (!runId) {
      throw new Error('runId is required');
    }
    const decision = validateAgentDecisionPayload(req.body);
    const data = await agentService.submitScheduleDecision(req.user.id, runId, decision);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    console.error('[Node Agent API] POST /api/agent/runs/:runId/decision failed:', {
      statusCode,
      message: getErrorMessage(error, 'Agent decision failed'),
      error
    });
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, 'Agent decision failed'),
      data: null
    });
  }
}

export async function submitAnnotation(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }
    const runId = String(req.params.runId || '').trim();
    if (!runId) {
      throw new Error('runId is required');
    }
    const annotation = validateAgentAnnotationPayload(req.body);
    const data = await agentService.submitPlanAnnotation(req.user.id, runId, annotation);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    console.error('[Node Agent API] POST /api/agent/runs/:runId/annotation failed:', {
      statusCode,
      message: getErrorMessage(error, 'Agent annotation failed'),
      error
    });
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, 'Agent annotation failed'),
      data: null
    });
  }
}

export async function listConversationMessages(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const data = await agentService.listConversationMessages(req.user.id);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询 Agent 会话消息失败'),
      data: null
    });
  }
}

export async function saveConversationMessage(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const payload = validateAgentConversationMessagePayload(req.body);
    const data = await agentService.saveConversationMessage(req.user.id, payload);
    res.status(201).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '保存 Agent 会话消息失败'),
      data: null
    });
  }
}

export async function clearConversationMessages(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    await agentService.clearConversationMessages(req.user.id);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data: { cleared: true }
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '清空 Agent 会话消息失败'),
      data: null
    });
  }
}

function readIsoField(body: unknown, field: string): string {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a valid ISO datetime string`);
  }
  // 容错：上游 LLM 偶尔会在 ISO 后面拼接说明文字，先提取干净的 ISO 段再校验
  const isoMatch = value.trim().match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  const normalized = isoMatch ? isoMatch[0] : value.trim();
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be a valid ISO datetime string`);
  }
  return normalized;
}

function readUserId(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const value = (body as Record<string, unknown>).userId;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('userId is required');
  }
  return value.trim();
}

export async function queryCalendarEventsForAgent(req: Request, res: Response): Promise<void> {
  try {
    const userId = readUserId(req.body);
    const startIso = readIsoField(req.body, 'startIso');
    const endIso = readIsoField(req.body, 'endIso');
    const events = await eventService.listEvents(userId, {
      start: startIso,
      end: endIso
    });

    console.log('[Node <- Python Tool] calendar_events_query:', {
      userId,
      startIso,
      endIso,
      eventCount: events.length
    });

    res.json({
      code: 0,
      message: 'ok',
      data: {
        events
      }
    });
  } catch (error) {
    res.status(400).json({
      code: 400,
      message: getErrorMessage(error, '查询用户已有日程失败'),
      data: null
    });
  }
}

/**
 * 页面重开恢复：返回该用户所有"应恢复"的任务
 * （running / waiting_user / paused_manual）。
 */
export async function listActiveJobs(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({
        code: 401,
        message: 'Unauthorized',
        data: null
      });
      return;
    }

    const data = await agentService.listActiveScheduleJobs(req.user.id);
    res.status(200).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    console.error('[Node Agent API] GET /api/agent/jobs/active failed:', {
      statusCode,
      message: getErrorMessage(error, '查询可恢复任务失败')
    });
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, '查询可恢复任务失败'),
      data: null
    });
  }
}

/**
 * 异常退出清理（sendBeacon 专用端点）。
 *
 * sendBeacon 无法携带 Authorization 头，也不能可靠设置 Content-Type，
 * 所以这个端点：
 * 1. 挂在 requireAuth 之前，用 body 里的 accessToken 自行做 JWT 校验；
 * 2. 用 express.text() 解析 text/plain 请求体后手动 JSON.parse；
 * 3. 在 csrfGuard 的豁免名单里（无 refresh cookie 时本就不校验，有 cookie 时 beacon 也带不上 CSRF 头）。
 */
export async function abortJobByBeacon(req: Request, res: Response): Promise<void> {
  try {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    let payload: { jobId?: unknown; token?: unknown; tabId?: unknown; reason?: unknown } = {};
    try {
      payload = JSON.parse(rawBody || '{}') as typeof payload;
    } catch {
      res.status(400).json({ code: 400, message: 'beacon body must be JSON text', data: null });
      return;
    }

    const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
    const token = typeof payload.token === 'string' ? payload.token.trim() : '';
    if (!jobId || !token) {
      res.status(400).json({ code: 400, message: 'jobId and token are required', data: null });
      return;
    }

    const userId = await verifyBeaconToken(token);
    if (!userId) {
      res.status(401).json({ code: 401, message: 'beacon token invalid', data: null });
      return;
    }

    const data = await requestAbortJob({
      userId,
      jobId,
      reason: typeof payload.reason === 'string' ? payload.reason : 'abnormal_exit'
    });
    res.status(200).json({ code: 0, message: 'ok', data });
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    console.warn('[Node Agent API] POST /api/agent/jobs/abort failed:', {
      statusCode,
      message: getErrorMessage(error, 'beacon abort failed')
    });
    // beacon 是 fire-and-forget，前端不读响应；这里只做日志
    res.status(statusCode).json({
      code: statusCode,
      message: getErrorMessage(error, 'beacon abort failed'),
      data: null
    });
  }
}

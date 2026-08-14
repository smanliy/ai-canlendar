import type { Request, Response } from 'express';

import * as agentService from './agent.service';
import { getAgentHttpStatus } from './agent.errors';
import { validateCreateAgentRunPayload } from './agent.schema';
import * as eventService from '../events/events.service';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

function readIsoField(body: unknown, field: string): string {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a valid ISO datetime string`);
  }
  return value.trim();
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

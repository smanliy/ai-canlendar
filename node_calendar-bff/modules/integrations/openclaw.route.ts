import { Router, type Request, type Response } from 'express';

import * as agentService from '../agent/agent.service';
import * as eventService from '../events/events.service';

export const openclawBridgeRoutes = Router();

function getBridgeToken(): string {
  return process.env.OPENCLAW_BRIDGE_TOKEN?.trim() || '';
}

function getBridgeUserId(): string {
  return process.env.OPENCLAW_BRIDGE_USER_ID?.trim() || 'openclaw-local';
}

function readBodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new Error('Request body must be a JSON object');
  }
  return req.body as Record<string, unknown>;
}

function readStringField(body: Record<string, unknown>, field: string, required = true): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    if (required) throw new Error(`${field} is required`);
    return '';
  }
  return value.trim();
}

function readOptionalObject(body: Record<string, unknown>, field: string): unknown {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireBridgeToken(req: Request, res: Response): boolean {
  const expected = getBridgeToken();
  if (!expected) return false;

  const provided = String(req.headers['x-openclaw-bridge-token'] || '').trim();
  if (provided !== expected) {
    res.status(401).json({
      code: 401,
      message: 'Invalid OpenClaw bridge token',
      data: null
    });
    return true;
  }
  return false;
}

// This route is the thin handoff from OpenClaw into the existing calendar backend.
openclawBridgeRoutes.post('/bridge', async (req, res) => {
  try {
    if (requireBridgeToken(req, res)) return;

    const body = readBodyObject(req);
    const action = readStringField(body, 'action');
    const userId = readStringField(body, 'userId', false) || getBridgeUserId();
    const runId = readStringField(body, 'runId', false);
    const input = readStringField(body, 'input', false);
    const payload = readOptionalObject(body, 'payload');

    if (action === 'create_run' && !input) {
      throw new Error('input is required for create_run');
    }

    switch (action) {
      case 'create_run': {
        const data = await agentService.createScheduleRun(userId, input, payload);
        res.status(201).json({ code: 0, message: 'ok', data });
        return;
      }
      case 'submit_decision': {
        const decision = payload as { optionId?: string; taskId?: string } | undefined;
        if (!runId) throw new Error('runId is required for submit_decision');
        if (!decision?.optionId || !decision?.taskId) throw new Error('payload.optionId and payload.taskId are required for submit_decision');
        const data = await agentService.submitScheduleDecision(userId, runId, {
          optionId: decision.optionId,
          taskId: decision.taskId
        });
        res.status(200).json({ code: 0, message: 'ok', data });
        return;
      }
      case 'submit_annotation': {
        if (!runId) throw new Error('runId is required for submit_annotation');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload is required for submit_annotation');
        const data = await agentService.submitPlanAnnotation(userId, runId, payload as never);
        res.status(200).json({ code: 0, message: 'ok', data });
        return;
      }
      case 'list_messages': {
        const data = await agentService.listConversationMessages(userId);
        res.status(200).json({ code: 0, message: 'ok', data });
        return;
      }
      case 'save_message': {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload is required for save_message');
        const data = await agentService.saveConversationMessage(userId, payload as never);
        res.status(201).json({ code: 0, message: 'ok', data });
        return;
      }
      case 'clear_messages': {
        if (userId) {
          await agentService.clearConversationMessages(userId);
          res.status(200).json({ code: 0, message: 'ok', data: { cleared: true, userId } });
        } else {
          res.status(400).json({ code: 400, message: 'userId is required for clear_messages', data: null });
        }
        return;
      }
      case 'query_calendar_events': {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must contain start and end values');
        const start = String((payload as Record<string, unknown>).start || '').trim();
        const end = String((payload as Record<string, unknown>).end || '').trim();
        if (!start || !end) throw new Error('payload.start and payload.end are required for query_calendar_events');
        const events = await eventService.listEvents(userId, { start, end });
        res.status(200).json({ code: 0, message: 'ok', data: { events } });
        return;
      }
      default:
        res.status(400).json({ code: 400, message: `Unsupported action: ${action}`, data: null });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bridge failed';
    res.status(400).json({ code: 400, message, data: null });
  }
});

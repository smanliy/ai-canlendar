import type { Request, Response } from 'express';

import { getAgentHttpStatus } from './agent.errors';
import { runAgentMainFlow, type AgentMainFlowEvent } from './agent-main-flow';
import { validateCreateAgentRunPayload } from './agent.schema';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function eventName(event: AgentMainFlowEvent): string {
  if (event.type === 'stepStarted') return 'step:start';
  if (event.type === 'stepUpdated') return 'step:update';
  if (event.type === 'stepSucceeded') return 'step:success';
  if (event.type === 'stepFailed') return 'step:failed';
  if (event.type === 'directAnswer') return 'direct:answer';
  if (event.type === 'commandResult') return 'command:result';
  return 'final';
}

export async function createRunStream(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({
      code: 401,
      message: 'Unauthorized',
      data: null
    });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const payload = validateCreateAgentRunPayload(req.body);

    writeSse(res, 'run:start', {
      input: payload.input,
      createdAt: new Date().toISOString()
    });

    await runAgentMainFlow({
      userId: req.user.id,
      input: payload.input,
      clarificationJson: payload.clarificationJson,
      onEvent(event) {
        writeSse(res, eventName(event), event);
      }
    });

    writeSse(res, 'done', { ok: true });
    res.end();
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    writeSse(res, 'error', {
      code: statusCode,
      message: getErrorMessage(error, 'Agent stream failed')
    });
    res.end();
  }
}

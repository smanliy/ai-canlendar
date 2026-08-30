import type { Request, Response } from 'express';

import { getAgentHttpStatus } from './agent.errors';
import { runAgentMainFlow, type AgentMainFlowEvent } from './agent-main-flow';
import * as agentService from './agent.service';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function streamJobEvents(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({
      code: 401,
      message: 'Unauthorized',
      data: null
    });
    return;
  }

  const jobId = String(req.params.jobId || '').trim();
  if (!jobId) {
    res.status(400).json({
      code: 400,
      message: 'jobId is required',
      data: null
    });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    let lastEventAt: Date | undefined;
    for (let pollCount = 0; pollCount < 300 && !closed; pollCount += 1) {
      const job = await agentService.getScheduleJob(req.user.id, jobId);
      const events = await agentService.listScheduleJobEvents(req.user.id, jobId);
      const nextEvents = lastEventAt ? events.filter((event) => event.createdAt > lastEventAt!) : events;

      for (const event of nextEvents) {
        writeSse(res, event.type, event);
        lastEventAt = event.createdAt;
      }

      if (['waiting_user', 'succeeded', 'failed', 'canceled'].includes(job.status)) {
        writeSse(res, 'job:state', job);
        writeSse(res, 'done', { ok: true, status: job.status });
        res.end();
        return;
      }

      writeSse(res, 'job:heartbeat', { jobId, status: job.status, at: new Date().toISOString() });
      await sleep(1000);
    }

    if (!closed) {
      writeSse(res, 'done', { ok: true, status: 'stream_timeout' });
      res.end();
    }
  } catch (error) {
    const statusCode = getAgentHttpStatus(error);
    writeSse(res, 'error', {
      code: statusCode,
      message: getErrorMessage(error, 'Agent job stream failed')
    });
    res.end();
  }
}

import type { Request, Response } from 'express';

import * as agentService from './agent.service';
import { validateCreateAgentRunPayload } from './agent.schema';

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
    const data = await agentService.createScheduleRun(req.user.id, payload.input);

    res.status(201).json({
      code: 0,
      message: 'ok',
      data
    });
  } catch (error) {
    res.status(400).json({
      code: 400,
      message: getErrorMessage(error, 'Agent failed'),
      data: null
    });
  }
}

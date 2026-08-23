import { Router } from 'express';

import * as agentController from './agent.controller';
import * as agentSseController from './agent.sse';
import { requireAuth } from '../middlewares/auth.middleware';

export const agentRoutes = Router();

agentRoutes.post('/internal/calendar-events', agentController.queryCalendarEventsForAgent);

agentRoutes.use(requireAuth);
agentRoutes.post('/runs/stream', agentSseController.createRunStream);
agentRoutes.post('/runs', agentController.createRun);
agentRoutes.post('/runs/:runId/decision', agentController.submitDecision);

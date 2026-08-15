import { Router } from 'express';

import * as agentController from './agent.controller';
import { requireAuth } from '../middlewares/auth.middleware';

export const agentRoutes = Router();

agentRoutes.post('/internal/calendar-events', agentController.queryCalendarEventsForAgent);

agentRoutes.use(requireAuth);
agentRoutes.post('/runs', agentController.createRun);
agentRoutes.post('/runs/:runId/decision', agentController.submitDecision);

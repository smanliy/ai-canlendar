import { Router } from 'express';

import * as agentController from './agent.controller';
import * as agentSseController from './agent.sse';
import { requireAuth } from '../middlewares/auth.middleware';

export const agentRoutes = Router();

agentRoutes.post('/internal/calendar-events', agentController.queryCalendarEventsForAgent);

agentRoutes.use(requireAuth);
agentRoutes.get('/compression', agentController.getCompressionSettings);
agentRoutes.patch('/compression', agentController.updateCompressionSettings);
agentRoutes.get('/token-metrics', agentController.getTokenMetrics);
agentRoutes.get('/messages', agentController.listConversationMessages);
agentRoutes.post('/messages', agentController.saveConversationMessage);
agentRoutes.delete('/messages', agentController.clearConversationMessages);
agentRoutes.post('/runs/stream', agentSseController.createRunStream);
agentRoutes.post('/runs', agentController.createRun);
agentRoutes.post('/jobs', agentController.createJob);
agentRoutes.get('/jobs', agentController.listJobs);
agentRoutes.get('/jobs/:jobId', agentController.getJob);
agentRoutes.get('/jobs/:jobId/events', agentController.listJobEvents);
agentRoutes.get('/jobs/:jobId/events/stream', agentSseController.streamJobEvents);
agentRoutes.post('/jobs/:jobId/cancel', agentController.cancelJob);
agentRoutes.post('/runs/:runId/decision', agentController.submitDecision);
agentRoutes.post('/runs/:runId/decision/jobs', agentController.createDecisionJob);
agentRoutes.post('/runs/:runId/rollback', agentController.rollbackRun);
agentRoutes.post('/runs/:runId/annotation', agentController.submitAnnotation);

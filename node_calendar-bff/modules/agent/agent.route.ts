import { Router } from 'express';

import * as agentController from './agent.controller';
import { requireAuth } from '../middlewares/auth.middleware';

export const agentRoutes = Router();

agentRoutes.use(requireAuth);
agentRoutes.post('/runs', agentController.createRun);

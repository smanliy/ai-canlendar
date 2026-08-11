import { Router } from 'express';

import * as eventController from './events.controller';
import { requireAuth } from '../middlewares/auth.middleware';

export const eventRoutes = Router();

eventRoutes.use(requireAuth);

eventRoutes.get('/', eventController.listEvents);
eventRoutes.post('/', eventController.createEvent);
eventRoutes.post('/bulk', eventController.bulkCreateEvents);
eventRoutes.patch('/:id', eventController.updateEvent);
eventRoutes.delete('/:id', eventController.deleteEvent);

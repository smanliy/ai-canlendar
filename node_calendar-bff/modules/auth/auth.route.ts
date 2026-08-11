import { Router } from 'express';

import * as authController from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/send-code', authController.sendCode);
authRoutes.post('/login', authController.login);
authRoutes.post('/register', authController.register);
authRoutes.post('/refresh', authController.refresh);
authRoutes.post('/logout', authController.logout);
authRoutes.get('/me', authController.me);

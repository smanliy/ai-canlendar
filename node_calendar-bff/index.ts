import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';

import { authRoutes } from './modules/auth/auth.route';
import { agentRoutes } from './modules/agent/agent.route';
import { eventRoutes } from './modules/events/events.routes';
import { CSRF_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from './modules/auth/auth.service';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  const publicAuthPaths = new Set(['/api/auth/send-code', '/api/auth/login', '/api/auth/register']);

  if (safeMethods.has(req.method) || publicAuthPaths.has(req.path)) {
    next();
    return;
  }

  const hasRefreshCookie = Boolean(req.cookies?.[REFRESH_TOKEN_COOKIE_NAME]);
  const csrfCookie = req.cookies?.[CSRF_COOKIE_NAME];
  const csrfHeader = req.headers['x-csrf-token'];

  if (hasRefreshCookie && (!csrfCookie || csrfHeader !== csrfCookie)) {
    res.status(403).json({
      code: 403,
      message: 'CSRF 校验失败，请刷新页面后重试',
      data: null
    });
    return;
  }

  next();
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin not allowed'));
    },
    credentials: true
  })
);
app.use(cookieParser());
app.use(express.json());
app.use(csrfGuard);

app.get('/', (_req: Request, res: Response) => {
  res.send('Hello! ChronoAgent BFF is running.');
});

app.use('/api/auth', authRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/events', eventRoutes);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : '服务异常';

  res.status(500).json({
    code: 500,
    message,
    data: null
  });
});

app.listen(port, () => {
  console.log(`ChronoAgent BFF listening at http://localhost:${port}`);
});

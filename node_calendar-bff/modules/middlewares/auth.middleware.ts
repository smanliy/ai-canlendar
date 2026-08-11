import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { prisma } from '../db/prisma';

interface AccessTokenPayload {
  sub: string;
  phone?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        phone: string;
      };
    }
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`服务端缺少环境变量 ${name}`);
  }
  return value;
}

function getBearerToken(req: Request): string | null {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length).trim();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ code: 401, message: '未登录或登录已过期', data: null });
      return;
    }

    const decoded = jwt.verify(token, getRequiredEnv('JWT_ACCESS_SECRET'));
    if (!decoded || typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      res.status(401).json({ code: 401, message: 'Token 无效', data: null });
      return;
    }

    const payload = decoded as AccessTokenPayload;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, phone: true, status: true }
    });

    if (!user || user.status !== 'active') {
      res.status(401).json({ code: 401, message: user ? '账号已被禁用' : '用户不存在，请重新登录', data: null });
      return;
    }

    req.user = {
      id: user.id,
      phone: user.phone
    };
    next();
  } catch {
    res.status(401).json({ code: 401, message: '登录已过期，请重新登录', data: null });
  }
}

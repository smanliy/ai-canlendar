import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '../db/prisma';
import type { LoginDto, RegisterDto, SendCodeDto } from './auth.schema';

const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const SMS_SEND_COOLDOWN_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_TOKEN_COOKIE_NAME = 'chrono_refresh_token';
export const CSRF_COOKIE_NAME = 'chrono_csrf_token';
export const REFRESH_TOKEN_COOKIE_MAX_AGE_MS = REFRESH_TOKEN_TTL_MS;

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

interface TokenUser {
  id: string;
  phone: string;
  nickname: string;
  avatarUrl: string | null;
}

interface AccessTokenPayload {
  sub: string;
  phone: string;
  nickname: string;
}

function normalizePhone(phone: unknown): string {
  return String(phone || '').replace(/\s+/g, '');
}

function validatePhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

function createCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`服务端缺少环境变量 ${name}`);
  }
  return value;
}

function createAccessToken(user: TokenUser): string {
  return jwt.sign(
    {
      sub: user.id,
      phone: user.phone,
      nickname: user.nickname
    },
    getRequiredEnv('JWT_ACCESS_SECRET'),
    {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS
    }
  );
}

function createRefreshToken(): string {
  return randomBytes(48).toString('hex');
}

export function createCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, getRequiredEnv('JWT_ACCESS_SECRET'));

    if (!decoded || typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      throw new Error('Token 无效');
    }

    return {
      sub: decoded.sub,
      phone: typeof decoded.phone === 'string' ? decoded.phone : '',
      nickname: typeof decoded.nickname === 'string' ? decoded.nickname : ''
    };
  } catch {
    throw new Error('登录已过期，请重新登录');
  }
}

async function verifySmsCode(phone: string, scene: SendCodeDto['scene'], code: string): Promise<void> {
  const record = await prisma.smsCode.findFirst({
    where: {
      phone,
      scene,
      consumedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  if (!record) {
    throw new Error('请先获取验证码');
  }

  const matched = await bcrypt.compare(code, record.codeHash);
  if (!matched) {
    throw new Error('验证码错误');
  }

  await prisma.smsCode.update({
    where: {
      id: record.id
    },
    data: {
      consumedAt: new Date()
    }
  });
}

async function createAuthResult(user: TokenUser, meta?: RequestMeta) {
  const token = createAccessToken(user);
  const refreshToken = createRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashValue(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent
    }
  });

  return {
    user,
    token,
    refreshToken,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString()
  };
}

function createPublicAuthResult(result: Awaited<ReturnType<typeof createAuthResult>>) {
  return {
    user: result.user,
    token: result.token,
    expiresAt: result.expiresAt
  };
}

export async function sendCode(payload: SendCodeDto, meta?: RequestMeta) {
  const phone = normalizePhone(payload.phone);
  const scene = payload.scene;

  if (!validatePhone(phone)) {
    throw new Error('请输入有效的 11 位手机号');
  }

  if (scene !== 'login' && scene !== 'register') {
    throw new Error('验证码场景不正确');
  }

  const existingUser = await prisma.user.findUnique({
    where: {
      phone
    },
    select: {
      id: true,
      status: true
    }
  });

  if (scene === 'login' && (!existingUser || existingUser.status !== 'active')) {
    throw new Error(existingUser ? '账号已被禁用' : '用户不存在，请先注册');
  }

  if (scene === 'register' && existingUser) {
    throw new Error('该手机号已注册，请直接登录');
  }

  const recentCode = await prisma.smsCode.findFirst({
    where: {
      phone,
      scene,
      createdAt: {
        gt: new Date(Date.now() - SMS_SEND_COOLDOWN_MS)
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  if (recentCode) {
    throw new Error('验证码发送过于频繁，请稍后再试');
  }

  const code = createCode();
  const codeHash = await bcrypt.hash(code, 10);

  await prisma.smsCode.create({
    data: {
      phone,
      scene,
      codeHash,
      expiresAt: new Date(Date.now() + SMS_CODE_TTL_MS),
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent
    }
  });

  console.log(`[Mock SMS] ${scene} 验证码：${code}，手机号：${phone}`);

  return {
    expiresIn: SMS_CODE_TTL_MS / 1000,
    cooldown: SMS_SEND_COOLDOWN_MS / 1000
  };
}

export async function login(payload: LoginDto, meta?: RequestMeta) {
  const phone = normalizePhone(payload.phone);
  const code = String(payload.code || '').trim();

  if (!validatePhone(phone)) {
    throw new Error('请输入有效的 11 位手机号');
  }

  if (!code) {
    throw new Error('请输入验证码');
  }

  await verifySmsCode(phone, 'login', code);

  const user = await prisma.user.findUnique({
    where: {
      phone
    },
    select: {
      id: true,
      phone: true,
      nickname: true,
      avatarUrl: true,
      status: true
    }
  });

  if (!user || user.status !== 'active') {
    throw new Error(user ? '账号已被禁用' : '用户不存在，请先注册');
  }

  await prisma.user.update({
    where: {
      id: user.id
    },
    data: {
      lastLoginAt: new Date()
    }
  });

  const result = await createAuthResult(
    {
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl
    },
    meta
  );

  return {
    ...createPublicAuthResult(result),
    refreshToken: result.refreshToken
  };
}

export async function register(payload: RegisterDto, meta?: RequestMeta) {
  const phone = normalizePhone(payload.phone);
  const code = String(payload.code || '').trim();
  const nickname = String(payload.nickname || '').trim();

  if (!validatePhone(phone)) {
    throw new Error('请输入有效的 11 位手机号');
  }

  if (!code) {
    throw new Error('请输入验证码');
  }

  if (!nickname) {
    throw new Error('请输入昵称');
  }

  const existingUser = await prisma.user.findUnique({
    where: {
      phone
    }
  });

  if (existingUser) {
    throw new Error('该手机号已注册，请直接登录');
  }

  await verifySmsCode(phone, 'register', code);

  const user = await prisma.user.create({
    data: {
      phone,
      nickname,
      preference: {
        create: {}
      }
    },
    select: {
      id: true,
      phone: true,
      nickname: true,
      avatarUrl: true
    }
  });

  const result = await createAuthResult(user, meta);

  return {
    ...createPublicAuthResult(result),
    refreshToken: result.refreshToken
  };
}

export async function me(token: string) {
  const payload = verifyAccessToken(token);

  const user = await prisma.user.findUnique({
    where: {
      id: payload.sub
    },
    select: {
      id: true,
      phone: true,
      nickname: true,
      avatarUrl: true,
      status: true
    }
  });

  if (!user || user.status !== 'active') {
    throw new Error(user ? '账号已被禁用' : '用户不存在，请重新登录');
  }

  return {
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl
  };
}

export async function refresh(refreshToken: string, meta?: RequestMeta) {
  const tokenHash = hashValue(refreshToken);
  const tokenRecord = await prisma.refreshToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    include: {
      user: {
        select: {
          id: true,
          phone: true,
          nickname: true,
          avatarUrl: true,
          status: true
        }
      }
    }
  });

  if (!tokenRecord || tokenRecord.user.status !== 'active') {
    throw new Error(tokenRecord ? '账号已被禁用' : '登录已过期，请重新登录');
  }

  await prisma.refreshToken.update({
    where: {
      id: tokenRecord.id
    },
    data: {
      revokedAt: new Date()
    }
  });

  const result = await createAuthResult(
    {
      id: tokenRecord.user.id,
      phone: tokenRecord.user.phone,
      nickname: tokenRecord.user.nickname,
      avatarUrl: tokenRecord.user.avatarUrl
    },
    meta
  );

  return {
    ...createPublicAuthResult(result),
    refreshToken: result.refreshToken
  };
}

export async function logout(refreshToken?: string) {
  if (!refreshToken) return;

  await prisma.refreshToken.updateMany({
    where: {
      tokenHash: hashValue(refreshToken),
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  });
}

import type { CookieOptions, Request, Response } from 'express';

import * as authService from './auth.service';
import {
  CSRF_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_MAX_AGE_MS,
  REFRESH_TOKEN_COOKIE_NAME
} from './auth.service';

const isProduction = process.env.NODE_ENV === 'production';

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE_MS
};

const csrfCookieOptions: CookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE_MS
};

function getRequestMeta(req: Request) {
  return {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getBearerToken(req: Request): string {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    throw new Error('未登录或登录已过期');
  }

  return authorization.slice('Bearer '.length).trim();
}

function getRefreshToken(req: Request): string | undefined {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  return typeof token === 'string' ? token : undefined;
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/api/auth'
  });
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  });
}

function sendAuthResult(
  res: Response,
  result: Awaited<ReturnType<typeof authService.login>>,
  message: string,
  statusCode = 200
): void {
  const csrfToken = authService.createCsrfToken();
  const { refreshToken, ...publicResult } = result;

  res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshCookieOptions);
  res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions);
  res.status(statusCode).json({
    code: 0,
    message,
    data: {
      ...publicResult,
      csrfToken
    }
  });
}

export async function sendCode(req: Request, res: Response): Promise<void> {
  try {
    console.log(
      `[Auth] send-code request scene=${String(req.body?.scene || '')} phone=${String(req.body?.phone || '')} origin=${String(req.headers.origin || '')}`
    );
    const result = await authService.sendCode(req.body, getRequestMeta(req));

    res.json({
      code: 0,
      message: '验证码已发送',
      data: result
    });
  } catch (error) {
    console.warn(`[Auth] send-code failed: ${getErrorMessage(error, '验证码发送失败')}`);
    res.status(400).json({
      code: 400,
      message: getErrorMessage(error, '验证码发送失败'),
      data: null
    });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const result = await authService.login(req.body, getRequestMeta(req));
    sendAuthResult(res, result, '登录成功');
  } catch (error) {
    res.status(400).json({
      code: 400,
      message: getErrorMessage(error, '登录失败'),
      data: null
    });
  }
}

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const result = await authService.register(req.body, getRequestMeta(req));
    sendAuthResult(res, result, '注册成功', 201);
  } catch (error) {
    res.status(400).json({
      code: 400,
      message: getErrorMessage(error, '注册失败'),
      data: null
    });
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const refreshToken = getRefreshToken(req);
    if (!refreshToken) {
      throw new Error('登录已过期，请重新登录');
    }

    const result = await authService.refresh(refreshToken, getRequestMeta(req));
    sendAuthResult(res, result, '登录态已刷新');
  } catch (error) {
    clearAuthCookies(res);
    res.status(401).json({
      code: 401,
      message: getErrorMessage(error, '登录已过期，请重新登录'),
      data: null
    });
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  try {
    await authService.logout(getRefreshToken(req));
    clearAuthCookies(res);
    res.json({
      code: 0,
      message: '已退出登录',
      data: true
    });
  } catch (error) {
    clearAuthCookies(res);
    res.status(400).json({
      code: 400,
      message: getErrorMessage(error, '退出登录失败'),
      data: null
    });
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  try {
    const result = await authService.me(getBearerToken(req));

    res.json({
      code: 0,
      message: 'ok',
      data: result
    });
  } catch (error) {
    res.status(401).json({
      code: 401,
      message: getErrorMessage(error, '未登录或登录已过期'),
      data: null
    });
  }
}

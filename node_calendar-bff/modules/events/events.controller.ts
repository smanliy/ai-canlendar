import type { Request, Response } from 'express';

import * as eventService from './events.service';
import { validateBulkCreatePayload, validateEventPayload, validateEventUpdatePayload } from './events.schema';

function getUserId(req: Request): string {
  if (!req.user?.id) {
    throw new Error('未登录或登录已过期');
  }
  return req.user.id;
}

function getRouteId(req: Request): string {
  const { id } = req.params;
  if (typeof id !== 'string' || !id) {
    throw new Error('日程 ID 不正确');
  }
  return id;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sendError(res: Response, error: unknown, fallback: string, status = 400) {
  res.status(status).json({
    code: status,
    message: getErrorMessage(error, fallback),
    data: null
  });
}

export async function listEvents(req: Request, res: Response): Promise<void> {
  try {
    const data = await eventService.listEvents(getUserId(req), req.query);
    res.json({ code: 0, message: 'ok', data });
  } catch (error) {
    sendError(res, error, '加载日程失败');
  }
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  try {
    const payload = validateEventPayload(req.body);
    const data = await eventService.createEvent(getUserId(req), payload);
    res.status(201).json({ code: 0, message: '日程已创建', data });
  } catch (error) {
    sendError(res, error, '创建日程失败');
  }
}

export async function updateEvent(req: Request, res: Response): Promise<void> {
  try {
    const payload = validateEventUpdatePayload(req.body);
    const data = await eventService.updateEvent(getUserId(req), getRouteId(req), payload);
    res.json({ code: 0, message: '日程已更新', data });
  } catch (error) {
    sendError(res, error, '更新日程失败');
  }
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  try {
    await eventService.deleteEvent(getUserId(req), getRouteId(req));
    res.json({ code: 0, message: '日程已删除', data: true });
  } catch (error) {
    sendError(res, error, '删除日程失败');
  }
}

export async function bulkCreateEvents(req: Request, res: Response): Promise<void> {
  try {
    const payload = validateBulkCreatePayload(req.body);
    const data = await eventService.bulkCreateEvents(getUserId(req), payload);
    res.status(201).json({ code: 0, message: '日程已批量创建', data });
  } catch (error) {
    sendError(res, error, '批量创建日程失败');
  }
}

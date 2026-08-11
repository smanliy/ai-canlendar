import { Tag } from 'antd';

import type { EventCategory, EventStatus } from '../types/event';

export const categoryColors: Record<EventCategory, string> = {
  工作: '#2563EB',
  学习: '#7C3AED',
  生活: '#16A34A',
  面试: '#F97316'
};

const statusColors: Record<EventStatus, string> = {
  未开始: 'default',
  进行中: 'processing',
  已完成: 'success',
  已延期: 'warning'
};

export function CategoryTag({ category }: { category: EventCategory }) {
  return <Tag color={categoryColors[category]}>{category}</Tag>;
}

export function StatusTag({ status }: { status: EventStatus }) {
  return <Tag color={statusColors[status]}>{status}</Tag>;
}

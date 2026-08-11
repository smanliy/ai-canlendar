import { Tag } from 'antd';

import type { EventPriority } from '../types/event';

const priorityColors: Record<EventPriority, string> = {
  高: '#DC2626',
  中: '#F59E0B',
  低: '#6B7280'
};

export function PriorityTag({ priority }: { priority: EventPriority }) {
  return <Tag color={priorityColors[priority]}>{priority}优先级</Tag>;
}

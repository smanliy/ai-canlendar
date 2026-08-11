export type EventCategory = '工作' | '学习' | '生活' | '面试';
export type EventPriority = '高' | '中' | '低';
export type EventStatus = '未开始' | '进行中' | '已完成' | '已延期';

export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
  category: EventCategory;
  priority: EventPriority;
  note?: string;
  status: EventStatus;
}

export type EventPayload = Omit<CalendarEvent, 'id'>;

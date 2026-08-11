export type EventCategory = string;
export type EventPriority = string;

export interface ParsedSubtask {
  title: string;
  minutes: number;
  order: number;
}

export interface ParsedScheduleTask {
  taskName: string;
  deadline: string;
  totalMinutes: number;
  priority: EventPriority;
  constraints: {
    avoidWeekends?: boolean;
    preferredTimeOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';
    preferredStartTime?: string;
    preferredEndTime?: string;
  };
  subtasks: ParsedSubtask[];
}

export interface AgentConflict {
  id: string;
  message: string;
}

export interface PlanItem {
  id: string;
  title: string;
  date: string;
  timeRange: string;
  durationHours: number;
  category: EventCategory;
  priority: EventPriority;
}

export interface SchedulePlan {
  taskName: string;
  deadline: string;
  totalHours: number;
  summary?: string;
  items: PlanItem[];
}

export interface SchedulePlanOption extends SchedulePlan {
  id: string;
  name: string;
  type?: 'generated' | 'custom';
  color?: string;
  accent?: string;
}

export interface AgentRunResponse {
  runId: string;
  status: 'waitingConfirm';
  rawInput: string;
  parsedTask: ParsedScheduleTask;
  plans: SchedulePlanOption[];
  plan: SchedulePlanOption;
  conflicts: AgentConflict[];
}

export type EventCategory = string;
export type EventPriority = string;

export interface ParsedSubtask {
  title: string;
  minutes: number;
  order: number;
  durationRangeMinutes?: [number, number];
  dependsOn?: string[];
  evidence?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    tool?: string;
    query?: string;
    provider?: string;
  }>;
  startAt?: string;
  endAt?: string;
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

export interface AgentUserPreference {
  preferredStartTime: string;
  preferredEndTime: string;
  dailyFocusLimitMinutes: number;
  avoidWeekends: boolean;
  defaultEventCategory: string;
  timezone: string;
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
  startAt?: string;
  endAt?: string;
  durationHours: number;
  category: EventCategory;
  priority: EventPriority;
  evidence?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    tool?: string;
    query?: string;
    provider?: string;
  }>;
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
  userPreference: AgentUserPreference;
  parsedTask: ParsedScheduleTask;
  pythonAgentAck?: {
    message: string;
    received?: unknown;
  };
  plans: SchedulePlanOption[];
  plan: SchedulePlanOption;
  conflicts: AgentConflict[];
  calendarEventsToolResult?: unknown;
  freeWindowsToolResult?: unknown;
  scheduleToolResult?: unknown;
}

export interface AgentClarificationResponse {
  runId: string;
  status: 'needsUserInput';
  rawInput: string;
  message: string;
  reasons: string[];
  clarificationJson: Record<string, unknown>;
}

export type AgentCreateRunResponse = AgentRunResponse | AgentClarificationResponse;

export interface AgentDecisionResponse {
  runId: string;
  status: 'waitingConfirm';
  plans: SchedulePlanOption[];
  plan: SchedulePlanOption;
  conflicts: AgentConflict[];
  scheduleToolResult?: unknown;
  splitResult?: unknown;
}

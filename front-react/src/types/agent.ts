import type { EventCategory, EventPriority } from './event';

export type AgentStepStatus = 'pending' | 'running' | 'success' | 'failed';
export type AgentRunStatus = 'idle' | 'running' | 'success' | 'failed' | 'waitingConfirm' | 'needsUserInput';

export interface AgentRunStep {
  id: string;
  name: string;
  status: AgentStepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentClarification {
  message: string;
  reasons: string[];
  clarificationJson: Record<string, unknown>;
}

export interface AgentUserPreference {
  preferredStartTime: string;
  preferredEndTime: string;
  dailyFocusLimitMinutes: number;
  avoidWeekends: boolean;
  defaultEventCategory: string;
  timezone: string;
}

export interface LocalCalendarEvent {
  id?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  startTime?: string;
  endTime?: string;
  category?: string;
  priority?: string;
  status?: string;
  source?: string;
}

export interface CalendarEventsToolResult {
  tool?: string;
  args?: {
    userId?: string;
    startIso?: string;
    endIso?: string;
  };
  events?: LocalCalendarEvent[];
  errors?: string[];
}

export interface FreeWindow {
  startIso: string;
  endIso: string;
  minutes: number;
  date?: string;
  windowType?: 'golden' | 'flexible';
  isGoldenTime?: boolean;
  source?: string;
}

export interface FreeWindowsToolResult {
  tool?: string;
  args?: {
    startIso?: string;
    endIso?: string;
    timezone?: string;
    schedulableStartTime?: string;
    schedulableEndTime?: string;
    goldenStartTime?: string;
    goldenEndTime?: string;
    dailyFocusLimitMinutes?: number | null;
    avoidWeekends?: boolean;
    minWindowMinutes?: number;
  };
  freeWindows?: FreeWindow[];
  totalFreeMinutes?: number;
  totalGoldenMinutes?: number;
  totalFlexibleMinutes?: number;
  errors?: string[];
}

export interface ScheduleInterruptOption {
  id: 'split_task' | 'allow_beyond_golden_time' | 'adjust_preference';
  title: string;
  description: string;
}

export interface SplitResult {
  parentTaskTitle?: string;
  subtaskTitles?: string[];
  subtasks?: unknown[];
}

export interface ScheduleInterrupt {
  type: string;
  taskId: string;
  taskTitle: string;
  taskMinutes: number;
  maxGoldenWindowMinutes: number;
  totalGoldenMinutes: number;
  reason: string;
  options: ScheduleInterruptOption[];
}

export interface DraftAllocation {
  taskId?: string;
  title?: string;
  order?: number;
  plannedMinutes?: number;
  startIso?: string;
  endIso?: string;
  windowType?: 'golden' | 'flexible';
  isGoldenTime?: boolean;
  policyFlags?: Record<string, unknown>;
}

export interface ScheduleToolResult {
  tool?: string;
  status?: 'ready' | 'needsDecision' | 'failed' | 'pending';
  draftAllocations?: DraftAllocation[];
  remainingFreeWindows?: FreeWindow[];
  interrupt?: ScheduleInterrupt | null;
  errors?: string[];
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

export interface AgentConflict {
  id: string;
  message: string;
}

export interface AgentRun {
  runId: string;
  status: AgentRunStatus;
  rawInput: string;
  steps: AgentRunStep[];
  plans: SchedulePlanOption[];
  selectedPlanId: string | null;
  conflicts: AgentConflict[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunDetail {
  runId: string;
  status: AgentRunStatus;
  rawInput: string;
  currentNodeName: string;
  nodeInput: unknown;
  nodeOutput: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentStep = AgentRunStep;
export type AgentPlan = SchedulePlan;

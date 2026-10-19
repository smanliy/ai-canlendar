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

export interface AgentTraceNode {
  id: string;
  label?: string;
  kind?: string;
  status?: string;
  detail?: unknown;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AgentTraceEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
}

export interface AgentTrace {
  name?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string | null;
  request?: unknown;
  detail?: unknown;
  nodes?: AgentTraceNode[];
  edges?: AgentTraceEdge[];
  events?: Array<Record<string, unknown>>;
}

export interface TokenUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
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
  reason?: string;
  warnings?: Array<{ type: string; message: string }>;
  editableTextRegions?: Array<{
    id: string;
    planCardId: string;
    path: string;
    text: string;
    kind: 'title' | 'summary' | 'reason' | 'block_title' | 'block_note';
  }>;
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
  plan?: SchedulePlanOption;
  conflicts: AgentConflict[];
  calendarEventsToolResult?: unknown;
  freeWindowsToolResult?: unknown;
  scheduleToolResult?: unknown;
  conflictCheckResult?: unknown;
  agentTrace?: AgentTrace;
  llmUsageByStep?: Record<string, TokenUsageSummary>;
}

export interface AgentClarificationResponse {
  runId: string;
  status: 'needsUserInput';
  rawInput: string;
  message: string;
  reasons: string[];
  clarificationJson: Record<string, unknown>;
  llmUsageByStep?: Record<string, TokenUsageSummary>;
}

export interface AgentCommandResponse {
  runId: string;
  status: 'commandResult';
  command: 'clear' | 'compact';
  message: string;
  summary?: string;
}

export interface AgentLlmAnswerResponse {
  runId: string;
  status: 'llmAnswer';
  rawInput: string;
  answer: string;
  reason: string;
}

export interface AgentEventSelectionOption {
  eventId: string;
  title: string;
  timeText: string;
}

/**
 * 日程定位歧义响应（三级定位的第 3 级）：
 * 前端收到后弹出选项框；用户选定后把 pendingOperation + eventId
 * POST 到 /agent/event-selection 完成操作。
 */
export interface AgentEventSelectionResponse {
  runId: string;
  status: 'needsSelection';
  rawInput: string;
  message: string;
  options: AgentEventSelectionOption[];
  pendingOperation: {
    kind: 'event_update' | 'event_delete';
    target?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    allowConflict?: boolean;
  };
  reason?: string;
}

export interface AgentAutoCreatedResponse {
  runId: string;
  status: 'autoCreated';
  rawInput: string;
  message: string;
  createdCount: number;
  plan: SchedulePlanOption;
  calendarEventsToolResult?: unknown;
  freeWindowsToolResult?: unknown;
  scheduleToolResult?: unknown;
  conflictCheckResult?: unknown;
  agentTrace?: AgentTrace;
  llmUsageByStep?: Record<string, TokenUsageSummary>;
}

export type AgentCreateRunResponse = AgentRunResponse | AgentClarificationResponse | AgentCommandResponse | AgentLlmAnswerResponse | AgentAutoCreatedResponse | AgentEventSelectionResponse | AgentConflictResolutionResponse;

export interface AgentEventConflictOption {
  eventId: string;
  title: string;
  timeText: string;
}

/**
 * 快速路径冲突挂起：检测到时间重叠时返回决策卡数据，
 * 前端用主 agent 的决策卡样式让用户选（保留冲突 / 原有日程后移 N 分钟 / 取消）。
 */
export interface AgentConflictResolutionResponse {
  runId: string;
  status: 'needsConflictResolution';
  rawInput: string;
  message: string;
  conflicts: AgentEventConflictOption[];
  /** 建议后移分钟数（把冲突日程推到新时段之后的最小位移，前端可编辑） */
  suggestedShiftMinutes: number;
  pendingOperation: {
    kind: 'event_create' | 'event_update';
    event?: Record<string, unknown>;
    target?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    allowConflict?: boolean;
  };
  reason?: string;
}

export interface AgentDecisionResponse {
  runId: string;
  status: 'waitingConfirm';
  plans: SchedulePlanOption[];
  plan?: SchedulePlanOption;
  conflicts: AgentConflict[];
  scheduleToolResult?: unknown;
  conflictCheckResult?: unknown;
  splitResult?: unknown;
  agentTrace?: AgentTrace;
  llmUsageByStep?: Record<string, TokenUsageSummary>;
}

export interface AgentAnnotationResponse {
  runId: string;
  status: 'waitingConfirm';
  plans: SchedulePlanOption[];
  plan?: SchedulePlanOption;
  conflicts: AgentConflict[];
  llmUsageByStep?: Record<string, TokenUsageSummary>;
  annotation: {
    planCardId: string;
    regionId: string;
    path: string;
    previousText: string;
    nextText: string;
    warning?: string;
  };
}

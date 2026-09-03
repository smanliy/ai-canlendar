import type { EventCategory, EventPriority } from './event';

export type AgentStepStatus = 'pending' | 'running' | 'success' | 'failed';
export type AgentRunStatus = 'idle' | 'running' | 'success' | 'failed' | 'waitingConfirm' | 'needsUserInput';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
}

export interface AgentCompressionSettings {
  enabled: boolean;
}

export interface AgentCompactionEvent {
  triggerType: 'manual' | 'auto' | 'micro';
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedRatio: number;
  thresholdTokens?: number;
  llmUsage?: TokenUsage;
}

export interface AgentNodeTokenMetric {
  nodeId: string;
  name: string;
  estimatedPromptTokens: number;
  actualPromptTokens: number;
  actualCompletionTokens: number;
  actualTotalTokens: number;
  model?: string;
}

export interface AgentTurnTokenMetric {
  turnId: number;
  runId: string;
  status: string;
  phase: string;
  compressionEnabled: boolean;
  contextTokensBefore: number;
  contextTokensAfter: number;
  baselineContextTokens: number;
  compressedContextTokens: number;
  savedTokens: number;
  savedRatio: number;
  totalLlmTokens: number;
  compactEvent?: AgentCompactionEvent;
  nodes: AgentNodeTokenMetric[];
  createdAt: string;
}

export interface AgentTokenMetricsSnapshot {
  settings: AgentCompressionSettings;
  samples: AgentTurnTokenMetric[];
  summary: {
    turnCount: number;
    baselineContextTokens: number;
    compressedContextTokens: number;
    savedTokens: number;
    savedRatio: number;
    totalLlmTokens: number;
    compressionEvents: number;
  };
}

export interface AgentRunStep {
  id: string;
  name: string;
  status: AgentStepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  llmUsage?: TokenUsage | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentClarification {
  message: string;
  reasons: string[];
  clarificationJson: Record<string, unknown>;
}

export interface AgentConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: 'userInput' | 'directAnswer' | 'agentSummary' | 'command';
  runId?: string;
  createdAt: string;
}

export type AgentJobType = 'schedule_plan' | 'resume_decision' | 'annotate_plan';
export type AgentJobStatus = 'queued' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'canceled';

export interface AgentJob {
  id: string;
  runId: string;
  userId: string;
  type: AgentJobType;
  status: AgentJobStatus;
  idempotencyKey: string | null;
  input: unknown;
  result: unknown | null;
  error: string | null;
  priority: number;
  attempt: number;
  maxAttempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentJobEvent {
  id: string;
  jobId: string;
  type: string;
  level: 'info' | 'warn' | 'error' | string;
  stepId: string | null;
  message: string | null;
  payload: unknown | null;
  traceId: string | null;
  parentEventId: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AgentCheckpoint {
  id: string;
  runId: string;
  userId: string;
  jobId: string | null;
  type: 'required_fields' | 'schedule_decision' | 'conflict_decision' | 'final_confirm' | 'annotation_review';
  stepName: string;
  prompt: string;
  options: unknown | null;
  resumePayload: unknown | null;
  stateSnapshot: unknown;
  status: 'pending' | 'resolved' | 'expired' | 'canceled';
  version: number;
  expiresAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentJobSummary {
  eventCount: number;
  errorCount: number;
  durationMs: number;
}

export interface AgentJobDetail extends AgentJob {
  checkpoint: AgentCheckpoint | null;
  eventSummary: AgentJobSummary;
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

export interface ConflictCheckResult {
  tool?: string;
  status?: 'ok' | 'needsDecision' | 'failed' | 'pending';
  summary?: {
    blocking?: number;
    approved?: number;
    total?: number;
  };
  conflicts?: Array<Record<string, unknown>>;
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

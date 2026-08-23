---
name: calendar-main-loop
description: Design, implement, or refactor the main loop for a single-session calendar scheduling Agent. Use for user input entry, slash command handling, LLM routing, direct LLM answers, delegation into existing Agent task splitting, required-field gatekeeping, plan-card return flow, frontend approval loops, and final database write boundaries.
---

这是日程排期 Agent 的主循环 Skill，用来规定用户输入后整条主流程怎么串起来。

# Calendar Main Loop

Use this skill when changing the outer request pipeline. Preserve the existing Agent task-splitting logic; connect to it instead of rewriting it.

## Claude Code QueryLoop Ideas To Preserve

Borrow these ideas from Claude Code's queryLoop design:

- Stream or return structured intermediate events instead of hiding the whole process behind one opaque call.
- Keep cross-turn state explicit in one state object.
- Decide whether to continue based on model/tool intent, not scattered implicit flags.
- Treat abnormal paths as first-class: missing fields, tool failures, conflict failures, invalid JSON, and interrupted flows must return structured results.
- Cap recovery loops and avoid infinite retries.

## End-To-End Flow

```text
User Input
  -> Command Handling
  -> LLM Router
  -> Direct LLM Answer OR Scheduling Agent Path
  -> Required Field Validation
  -> Tool Queries
  -> Free Time Search
  -> Plan Card Generation
  -> Golden Time Handling
  -> Conflict Detection
  -> Conflict Replanning If Needed
  -> Frontend Plan Card Display
  -> User Approves / Annotates / DIY Edits
  -> ReAct Revision Loop If Needed
  -> Final Approval
  -> Write To Database
```

## Main Handler Contract

```ts
async function handleUserInput(userInput: string, state: SchedulingSessionState) {
  const command = parseCommand(userInput)

  if (command === "clear") return clearSchedulingSession(state)
  if (command === "compat") return compactSchedulingSession(state)

  state.messages.push({ role: "user", content: userInput })

  const route = await callLLMRouter({ userInput, state })

  if (!route.needAgent) {
    state.messages.push({ role: "assistant", content: route.directAnswer ?? "" })
    return { type: "llm_answer", state, output: route.directAnswer ?? "" }
  }

  return runSchedulingAgentFlow({ userInput, state })
}
```

## LLM Router

The router only decides whether to enter the existing Agent flow. It must not perform full scheduling or task splitting.

```ts
type RouteResult = {
  needAgent: boolean
  reason: string
  directAnswer?: string
}
```

Use `needAgent=false` for simple chat, simple explanation, or non-scheduling answers that do not require project state, tools, or planning.

Use `needAgent=true` for creating, modifying, arranging, optimizing, confirming, annotating, revising, DIY editing, or writing schedules.

## Scheduling Agent Path

When `needAgent=true`:

1. Extract scheduling fields from user input and current state.
2. Validate required fields with `calendar-field-validation`.
3. If required fields are missing, return a frontend action asking the user to fill them. Do not call tools.
4. If fields are complete, call tools with `calendar-tool-query`.
5. Generate plan cards with `calendar-plan-card`.
6. If golden time cannot be satisfied, use `calendar-golden-time`.
7. Detect and resolve conflicts with `calendar-conflict-resolution`.
8. Return plan cards to the frontend.
9. Let frontend approval, annotation, or DIY edits continue through `calendar-frontend-react` and `calendar-diy-finalize`.

## Session State

```ts
type SchedulingSessionState = {
  messages: Message[]
  summary: string | null
  currentRequest: SchedulingRequest | null
  extractedFields: ExtractedSchedulingFields
  missingFields: MissingField[]
  toolResults: SchedulingToolResults
  freeTimeSlots: TimeSlot[]
  planCards: PlanCard[]
  selectedPlanCardId: string | null
  userAnnotations: UserAnnotation[]
  userConflictApprovals: ConflictApproval[]
  conflicts: ConflictRecord[]
  warnings: WarningRecord[]
  agentState: unknown | null
  pendingFrontendAction: FrontendAction | null
}
```

Adapt field names to the project, but keep the state explicit and inspectable.

## Output Types

Return structured results to Node/frontend:

```ts
type SchedulingFlowResult =
  | { type: "llm_answer"; output: string; state: SchedulingSessionState }
  | { type: "need_more_info"; missingFields: MissingField[]; frontendAction: FrontendAction; state: SchedulingSessionState }
  | { type: "need_user_choice"; frontendAction: FrontendAction; planCards?: PlanCard[]; state: SchedulingSessionState }
  | { type: "plan_cards"; planCards: PlanCard[]; warnings?: WarningRecord[]; conflicts?: ConflictRecord[]; state: SchedulingSessionState }
  | { type: "write_success"; scheduleId: string; state: SchedulingSessionState }
  | { type: "error"; reason: string; recoverable: boolean; state: SchedulingSessionState }
```

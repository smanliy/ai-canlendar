---
name: calendar-command-memory
description: Implement command handling and memory management for a single-session calendar Agent. Use for /clear, /compat, conversation memory reset, context compression, preserving scheduling state, and reducing token usage without losing useful scheduling information.
---

这是日程排期 Agent 的命令与单会话记忆 Skill，用来规定 `/clear` 和 `/compat` 如何影响当前唯一会话。

# Calendar Command Memory

Handle slash commands before calling the LLM router or Agent flow.

## Single-Session Rule

The project currently has one active conversation. `/clear` and `/compat` operate on the current single state object. Do not add `sessionId`, `threadId`, or multi-session storage unless the product explicitly changes.

## /clear

`/clear` clears all memory for the current scheduling interaction.

Clear:

- conversation messages
- compressed summary
- pending scheduling request
- extracted scheduling fields
- missing fields
- generated plan cards
- conflict records
- warnings
- tool query results
- local free-time results
- temporary Agent state
- frontend selection, annotation, or pending action state

Do not clear:

- user account data
- calendar database
- model config
- system prompt template
- tool registry
- application settings
- project files

```ts
function clearSchedulingSession(): SchedulingSessionState {
  return {
    messages: [],
    summary: null,
    currentRequest: null,
    extractedFields: {},
    missingFields: [],
    toolResults: {},
    freeTimeSlots: [],
    planCards: [],
    selectedPlanCardId: null,
    userAnnotations: [],
    userConflictApprovals: [],
    conflicts: [],
    warnings: [],
    agentState: null,
    pendingFrontendAction: null,
  }
}
```

## /compat

`/compat` compresses context while preserving useful scheduling state so the user can continue with lower token cost.

Preserve:

- current scheduling goal
- extracted required fields
- missing fields still waiting for user input
- deadline
- estimated duration
- user preferences
- unavailable times
- local calendar query results that are still valid
- free-time slots that are still valid
- generated plan cards
- selected plan card
- user annotations or requested edits
- conflict decisions already approved by the user
- pending next frontend action

Discard:

- repeated conversation
- obsolete intermediate reasoning
- raw tool logs already summarized
- old failed plans no longer relevant
- unnecessary model explanations

## Compact Result

```ts
type CompactResult = {
  summary: string
  preservedFields: ExtractedSchedulingFields
  preservedTasks: Task[]
  preservedToolResults: SchedulingToolResults
  preservedPlanCards: PlanCard[]
  preservedConflicts: ConflictRecord[]
  preservedApprovals: ConflictApproval[]
  pendingFrontendAction: FrontendAction | null
}
```

After compaction, replace long message history with one compressed memory message:

```ts
state.messages = [
  {
    role: "system",
    content: `Compressed scheduling memory:\n${compactResult.summary}`,
  },
]
```

Do not pretend compaction is lossless. Keep structured state fields outside the prose summary when the frontend or Agent still needs exact values.

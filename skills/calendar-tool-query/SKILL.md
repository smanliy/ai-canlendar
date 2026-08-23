---
name: calendar-tool-query
description: Govern external and local tool queries for a calendar scheduling Agent. Use for local calendar lookup, free-time search, external information lookup, user preference lookup, tool-call preconditions, and safe tool execution after required field validation.
---

这是日程排期 Agent 的工具查询 Skill，用来规定什么时候能调用外部工具、本地日程和本地空闲时间搜索。

# Calendar Tool Query

Call tools only after required scheduling fields pass validation.

## Preconditions

Before tool calls:

- `deadline` must exist.
- `estimatedDuration` must exist.
- The user request must require scheduling, modification, validation, or plan generation.
- Existing Agent task-splitting logic may decide which tool group is needed.

If required fields are missing, stop and use `calendar-field-validation`.

## Tool Categories

Tool queries may include:

- external information lookup
- local calendar query
- existing schedule query
- user preference query
- local free-time calculation
- task duration estimation, only if product design allows estimation

```ts
type SchedulingToolResults = {
  externalInfo?: unknown
  localCalendar?: CalendarEvent[]
  existingSchedules?: CalendarEvent[]
  userPreferences?: UserPreference[]
}
```

## Local Free-Time Search

Find free time from local calendar events, deadline, estimated duration, and preferences.

```ts
type FreeTimeSearchInput = {
  localCalendar: CalendarEvent[]
  deadline: string
  estimatedDuration: number
  preferences: ExtractedSchedulingFields
}
```

```ts
type TimeSlot = {
  id: string
  startTime: string
  endTime: string
  durationMinutes: number
  score?: number
  tags?: string[]
}
```

## Claude Code QueryLoop Reference

Borrow the tool execution principle from Claude Code:

- Read-only queries can be parallelized when safe.
- Mutating operations must be serialized.
- Unknown tool safety should fail closed.
- Tool failures should become structured results, not unhandled crashes.

For this project, local calendar reads and preference reads are usually read-only. Database writes are not tool queries; they belong to `calendar-diy-finalize`.

## Output

Return tool results into state:

```ts
state.toolResults = toolResults
state.freeTimeSlots = freeTimeSlots
```

Then continue to `calendar-plan-card`.

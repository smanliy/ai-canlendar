---
name: calendar-plan-card
description: Define and generate frontend plan cards for a calendar scheduling Agent. Use for plan-card schema, schedule blocks, displayable reasons, warnings, conflicts, editable text regions, and returning one or more scheduling options to the frontend.
---

这是日程排期 Agent 的方案卡 Skill，用来规定后端生成给前端展示和编辑的排期方案结构。

# Calendar Plan Card

Plan cards are the main frontend-facing artifact. Generate one or more cards after fields pass validation, tools return data, and free-time slots are found.

## Inputs

Use:

- user request
- extracted scheduling fields
- deadline
- estimated duration
- free-time slots
- local calendar events
- user preferences
- golden-time requirements
- known conflicts

## Plan Card Schema

```ts
type PlanCard = {
  id: string
  title: string
  summary: string
  scheduleBlocks: ScheduleBlock[]
  reason: string
  warnings: WarningRecord[]
  conflicts: ConflictRecord[]
  editableTextRegions: EditableTextRegion[]
}
```

```ts
type ScheduleBlock = {
  id: string
  title: string
  startTime: string
  endTime: string
  durationMinutes: number
  location?: string
  note?: string
}
```

```ts
type EditableTextRegion = {
  id: string
  planCardId: string
  path: string
  text: string
  kind: "title" | "summary" | "reason" | "block_title" | "block_note"
}
```

## Generation Rules

- Generate cards that the frontend can render directly.
- Include the reason for each plan in user-facing language.
- Include warnings for approved conflicts or soft concerns.
- Include conflicts for blocking issues that still need resolution.
- Mark editable text regions so frontend selected-text annotation can map back to a stable region.
- Do not write to database from this step.

## Handoff

After generation:

1. Run golden-time handling if needed.
2. Run conflict detection.
3. Return cards to frontend only after blocking conflicts are resolved or clearly represented.

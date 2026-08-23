---
name: calendar-conflict-resolution
description: Detect, classify, warn about, and replan calendar conflicts. Use for approved conflicts, warning-only conflicts, blocking conflicts, conflict records, replanning, and preventing unapproved conflicts from being written to the database.
---

这是日程排期 Agent 的冲突处理 Skill，用来规定哪些冲突只提示，哪些冲突必须重排。

# Calendar Conflict Resolution

Run conflict detection after generating plan cards and again after frontend ReAct edits or DIY edits that change time blocks.

## Conflict Record

```ts
type ConflictRecord = {
  id: string
  planCardId: string
  scheduleBlockId: string
  conflictingEventId: string
  severity: "warning" | "blocking"
  userApproved: boolean
  reason: string
}
```

## Rule

- If a conflict was explicitly approved by the user, keep it and show a warning.
- If a conflict was not approved, treat it as blocking and replan.
- Do not write a blocking conflict to the database.

```ts
if (conflict.userApproved) {
  warnings.push({
    type: "approved_conflict",
    message: "该冲突已由用户允许，仅作为提醒展示。",
  })
} else {
  replanRequired = true
}
```

## Replanning

When unapproved conflicts exist:

1. Remove or adjust conflicting schedule blocks.
2. Search remaining free-time slots.
3. Preserve user preferences as much as possible.
4. Preserve approved conflicts.
5. Generate revised plan cards.
6. Detect conflicts again.

Cap replanning attempts to avoid infinite loops.

## Frontend Output

Warnings may be displayed with plan cards. Blocking conflicts should not be hidden.

```ts
return {
  type: "plan_cards",
  planCards,
  warnings,
  conflicts,
  state,
}
```

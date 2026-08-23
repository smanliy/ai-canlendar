---
name: calendar-diy-finalize
description: Handle DIY scheduling edits, final user approval, validation before persistence, and database writes for a calendar Agent. Use when the user manually edits the final card, chooses a plan, clicks final confirm, or the backend needs to write approved schedule blocks to the database.
---

这是日程排期 Agent 的 DIY 与最终写库 Skill，用来规定用户手动排期和最终同意后的持久化边界。

# Calendar DIY Finalize

The user may manually edit the final card. Treat DIY edits as authoritative intent, but still validate before writing.

## DIY Validation

Before writing DIY results:

- check required fields
- check time format
- check duration
- check deadline
- detect conflicts
- warning only for user-approved conflicts
- block or replan for unapproved conflicts

## Final Write Conditions

```ts
type FinalWriteCondition = {
  hasSelectedPlan: boolean
  requiredFieldsComplete: boolean
  conflictsResolvedOrApproved: boolean
  userClickedFinalConfirm: boolean
}
```

Only write to database after explicit final approval.

```ts
await writeScheduleToDatabase({
  planCardId: selectedPlanCard.id,
  scheduleBlocks: selectedPlanCard.scheduleBlocks,
  source: "agent_plan" | "diy",
})
```

## After Write

After successful write:

- append final assistant message to conversation memory
- clear pending frontend action
- keep summary of written schedule
- return `write_success` to frontend

```ts
return {
  type: "write_success",
  scheduleId,
  state,
}
```

## Rule

Never write plan cards, DIY edits, or conflict-containing schedules to the database before the user clicks final confirm.

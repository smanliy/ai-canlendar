---
name: calendar-frontend-react
description: Handle frontend ReAct interactions for calendar plan cards. Use when the user selects a plan, selects text, adds annotations, asks the LLM to revise part of a card, approves conflicts, or triggers a revision loop before final confirmation.
---

这是日程排期 Agent 的前端 ReAct Skill，用来处理方案卡上的选中、批注、局部修改和重新生成。

# Calendar Frontend ReAct

Use this skill after plan cards are displayed and the frontend sends follow-up actions.

## Supported Actions

```ts
type FrontendAction =
  | { type: "approve_plan"; planCardId: string }
  | { type: "annotate_text"; planCardId: string; regionId: string; comment: string }
  | { type: "revise_selected_text"; planCardId: string; regionId: string; instruction: string }
  | { type: "diy_edit"; planCardId: string; editedBlocks: ScheduleBlock[] }
  | { type: "approve_conflict"; conflictId: string }
  | { type: "final_confirm"; planCardId: string }
```

## ReAct Revision Loop

For selected-text annotation:

```text
User annotation
  -> LLM interprets requested change
  -> Agent decides whether tools or schedule recalculation are needed
  -> Query tools / recalculate if needed
  -> Update plan card
  -> Detect conflicts again
  -> Return revised card
```

Preserve:

- original scheduling goal
- required fields
- user preferences
- approved conflicts
- selected region ID
- annotation intent

## Rules

- Text-only edits can update card copy without re-querying calendar tools.
- Time-block edits require conflict detection.
- Edits that change duration, deadline, preferred time, or split behavior may require free-time recalculation.
- Final confirmation belongs to `calendar-diy-finalize`.

Return revised plan cards, not database writes.

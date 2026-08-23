---
name: calendar-golden-time
description: Handle golden-time scheduling constraints for a calendar Agent. Use when a plan cannot fit into the user's preferred high-value time, when the frontend must ask the user how to proceed, or when existing golden-time product logic should be invoked instead of silently forcing a poor schedule.
---

这是日程排期 Agent 的黄金时间 Skill，用来处理方案无法安排到用户黄金时间时的分支。

# Calendar Golden Time

If a plan cannot be arranged in the user's golden time, do not silently force a bad plan.

The project already has a user-choice flow for this case. Prefer handing off to that existing frontend/product logic instead of rewriting it.

## Detection

Trigger this flow when:

- `goldenTimeRequired` is true and no plan block fits golden time.
- Most plan blocks fall outside preferred high-value ranges.
- Meeting the deadline requires violating golden-time preference.

## Frontend Action

```ts
type GoldenTimeFrontendAction = {
  type: "golden_time_unavailable"
  message: string
  options: Array<{
    id: string
    label: string
    effect: string
  }>
}
```

Possible options:

- accept non-golden time
- relax deadline
- split the task
- reduce duration
- manually choose time
- cancel scheduling

## Rule

Return `need_user_choice` and pause automatic scheduling until the user chooses.

```ts
return {
  type: "need_user_choice",
  state,
  planCards,
  frontendAction: {
    type: "golden_time_unavailable",
    message,
    options,
  },
}
```

After the user chooses, resume the main loop through the normal Agent path.

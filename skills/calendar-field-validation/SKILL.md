---
name: calendar-field-validation
description: Validate required scheduling fields for a calendar Agent before tool calls or plan generation. Use for deadline, estimated duration, missing-field frontend prompts, extracted scheduling fields, and stopping the Agent flow until required information is provided.
---

这是日程排期 Agent 的字段校验 Skill，用来保证信息不足时先让前端补填，而不是继续调用工具或猜测排期。

# Calendar Field Validation

Validate required fields before local calendar queries, external tool calls, free-time search, plan-card generation, or database write.

## Required Fields

Minimum required fields:

- `deadline`: 截止时间
- `estimatedDuration`: 预计花费时间

Do not schedule if either is missing.

## Extracted Fields

```ts
type ExtractedSchedulingFields = {
  title?: string
  description?: string
  deadline?: string
  estimatedDuration?: number
  preferredTimeRanges?: TimeRange[]
  preferredDays?: string[]
  avoidTimeRanges?: TimeRange[]
  priority?: "low" | "medium" | "high"
  location?: string
  participants?: string[]
  canSplit?: boolean
  splitRule?: string
  goldenTimeRequired?: boolean
  allowConflict?: boolean
}
```

## Missing Field Response

When required fields are missing, return to Node/backend, and let Node return a frontend action. Do not continue the Agent flow.

```ts
type MissingField = {
  field: "deadline" | "estimatedDuration" | string
  reason: string
  frontendPrompt: string
  inputType: "datetime" | "duration" | "text" | "select"
}
```

```ts
function validateRequiredFields(fields: ExtractedSchedulingFields) {
  const missingFields: MissingField[] = []

  if (!fields.deadline) {
    missingFields.push({
      field: "deadline",
      reason: "Scheduling requires a deadline.",
      frontendPrompt: "请选择截止时间",
      inputType: "datetime",
    })
  }

  if (!fields.estimatedDuration) {
    missingFields.push({
      field: "estimatedDuration",
      reason: "Scheduling requires estimated task duration.",
      frontendPrompt: "请输入预计花费时间",
      inputType: "duration",
    })
  }

  return { ok: missingFields.length === 0, missingFields }
}
```

## Rule

If validation fails, return:

```ts
{
  type: "need_more_info",
  missingFields,
  frontendAction: {
    type: "request_required_fields",
    fields: missingFields,
  },
  state,
}
```

Do not call calendar tools, free-time search, plan generation, or conflict detection until validation passes.

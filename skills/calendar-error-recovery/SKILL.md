---
name: calendar-error-recovery
description: Handle abnormal paths and recovery for a calendar scheduling Agent. Use for invalid LLM JSON, tool failure, prompt/context overflow, missing tool results, interrupted flows, database write failure, no free time found, replanning failure, and structured terminal reasons inspired by Claude Code queryLoop.
---

这是日程排期 Agent 的异常恢复 Skill，用来把 Claude Code 主循环里的容错思想迁移到本项目。

# Calendar Error Recovery

Industrial Agent code is mostly abnormal paths. Follow Claude Code queryLoop's design philosophy: recover when possible, return structured reasons when not, and keep state valid for the next user action.

## Structured Reasons

```ts
type CalendarStopReason =
  | "completed"
  | "need_more_info"
  | "need_user_choice"
  | "invalid_llm_json"
  | "tool_failed"
  | "calendar_query_failed"
  | "no_free_time"
  | "golden_time_unavailable"
  | "unapproved_conflict"
  | "replan_failed"
  | "database_write_failed"
  | "prompt_too_long"
  | "output_truncated"
  | "user_cancelled"
```

## Invalid LLM Output

If the router or Agent expects JSON and the model returns invalid JSON:

1. Retry once with a repair prompt.
2. If repair fails, return `invalid_llm_json`.
3. Do not continue with guessed fields.

## Prompt Too Long

Use `/compat` style compaction:

1. Preserve scheduling goal, required fields, plan cards, selected card, conflicts, approvals, and pending frontend action.
2. Replace long history with a compact memory summary.
3. Retry once if appropriate.
4. Return `prompt_too_long` if still too large.

## Tool Failure

Tool errors should become structured tool results or frontend errors, not crashes.

For read/query tools:

- retry if transient
- return partial plan only if safe
- otherwise return `tool_failed` or `calendar_query_failed`

For database writes:

- do not pretend success
- return `database_write_failed`
- keep selected plan in state so user can retry

## No Free Time

If no free slot can satisfy deadline and duration:

- ask user to relax deadline
- ask user to split task
- ask user to reduce duration
- ask user to accept conflict
- offer DIY scheduling

Return `need_user_choice`.

## Replanning Failure

If unapproved conflicts remain after capped replanning attempts:

- return plan cards with blocking conflict details
- ask user to choose how to proceed
- do not write to database

## Interruption

If user cancels or the flow is interrupted:

- stop new tool calls
- keep state protocol-valid
- preserve completed user choices
- return `user_cancelled`

## Claude Code Reference

Preserve these implementation ideas:

- Keep cross-turn state explicit, not hidden in closures.
- Add caps to retries and replanning.
- Repair protocol-shaped failures when possible.
- Return structured terminal reasons.
- Prefer an ugly recoverable state over an elegant crash.

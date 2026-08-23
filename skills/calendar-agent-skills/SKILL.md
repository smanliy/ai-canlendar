---
name: calendar-agent-skills
description: Index and routing guide for a calendar scheduling Agent skill set. Use when deciding which local calendar Agent skill to apply for main loop design, command memory, field validation, tool queries, plan cards, golden-time handling, conflict resolution, frontend ReAct edits, DIY finalization, database writes, or error recovery.
---

这是日程排期 Agent 的 Skill 索引，用来决定当前任务应该读取和遵循哪个更具体的 Skill。

# Calendar Agent Skills

Use this skill as the local index for the calendar scheduling Agent. Do not put all implementation details here. Select the smallest relevant skill first, then combine additional skills only when the change crosses boundaries.

## Skill Map

- Use `calendar-main-loop` for the end-to-end request flow: user input, command handling, LLM routing, direct answer, Agent path, frontend response, and final write boundary.
- Use `calendar-command-memory` for `/clear`, `/compat`, single-session memory, context compression, and what to preserve or discard.
- Use `calendar-field-validation` for required scheduling fields such as deadline and estimated duration, and for returning missing-field requests to Node/frontend.
- Use `calendar-tool-query` for external lookups, local calendar queries, local free-time search, and tool-call preconditions.
- Use `calendar-plan-card` for plan-card schemas, generation rules, editable regions, warnings, and frontend display contracts.
- Use `calendar-golden-time` for cases where a plan cannot be arranged in the user's golden time and the existing product flow must ask the user how to proceed.
- Use `calendar-conflict-resolution` for conflict detection, user-approved conflicts, warnings, blocking conflicts, and replanning.
- Use `calendar-frontend-react` for frontend selected text, annotations, LLM revisions, and ReAct-style card updates.
- Use `calendar-diy-finalize` for DIY scheduling, final approval, validation before write, and database persistence.
- Use `calendar-error-recovery` for unexpected paths inspired by Claude Code's queryLoop: invalid model output, prompt overflow, tool failure, interrupted flows, missing tool results, and safe structured exits.
- Use `agent-query-loop-reference` for the source-inspired Claude Code queryLoop architecture: ask/query/queryLoop layering, async streaming, tool_use/tool_result pairing, StreamingToolExecutor, explicit State, reactive compaction, max-output recovery, and terminal reasons.

## Recommended Load Order

For main-flow work:

1. Read `calendar-main-loop`.
2. Read the specific domain skill for the affected flow.
3. Read `calendar-error-recovery` if the change touches failures, retries, interruption, or fallback.
4. Read `agent-query-loop-reference` if the work changes core Agent loop architecture or should preserve Claude Code-style implementation ideas.

For frontend card work:

1. Read `calendar-plan-card`.
2. Read `calendar-frontend-react`.
3. Read `calendar-conflict-resolution` if edits can change time blocks.

For final write work:

1. Read `calendar-diy-finalize`.
2. Read `calendar-conflict-resolution`.
3. Read `calendar-error-recovery`.

## Project Boundary

This project currently has one active conversation, not multiple sessions. Do not introduce multi-session concepts unless the project explicitly adds them later.

The existing Agent task-splitting logic already exists. Do not rewrite it when working on the outer main flow. Treat it as a black-box function that can be called after routing and required-field validation.

---
name: agent-query-loop-reference
description: Reference Claude Code-style query loop architecture for industrial Agent design. Use when designing, reviewing, or refactoring an Agent main loop with ask/query/queryLoop layers, async streaming, tool_use/tool_result handling, StreamingToolExecutor-style overlap, explicit cross-turn State, reactive context compaction, max-output recovery, interruption handling, terminal reasons, and robust abnormal-path recovery.
---

这是 Claude Code 主循环 Query 参考 Skill，用来保留文章里的源码实现思路，并把它转成可复用的工业级 Agent 主循环设计规范。

# Agent Query Loop Reference

Use this skill as an architecture reference. It is not calendar-specific. For this project, combine it with `calendar-main-loop` and `calendar-error-recovery` when you want to improve the calendar Agent's outer flow, streaming design, state model, tool handling, or recovery behavior.

## Core Lesson

Do not treat an Agent as one model call. A real Agent turn is a loop:

```text
call model
-> stream text and tool requests
-> decide whether follow-up is needed
-> run tools
-> append tool results
-> call model again
-> stop only when no further tool/action request exists
```

A toy implementation can be 20 lines. A production implementation spends most of its code on abnormal paths: aborts, tool failures, missing tool results, prompt overflow, output truncation, max turns, and protocol repair.

## Four-Layer Call Chain

Use four conceptual layers:

```text
ask
  -> QueryEngine.submitMessage
    -> query
      -> queryLoop
```

### ask

SDK or CLI entry point. It receives one prompt, creates or uses a query engine, and forwards streamed events outward.

```ts
async function* ask(params) {
  const engine = new QueryEngine(config)
  yield* engine.submitMessage(params.prompt)
}
```

### QueryEngine.submitMessage

Session layer. It owns conversation history and durable per-session state.

Typical responsibilities:

- slash commands
- system prompt assembly
- context injection
- message history
- file or data cache
- permission denial records
- tool registry

```ts
class QueryEngine {
  async *submitMessage(prompt) {
    const messages = await this.prepareMessages(prompt)
    yield* query({ messages, systemPrompt, tools, state })
  }
}
```

### query

Streaming wrapper layer. It uses an async generator so outer callers can receive events while work is happening.

```ts
async function* query(params) {
  const terminal = yield* queryLoop(params)
  return terminal
}
```

`yield*` is important: it forwards every event emitted by the inner generator without waiting for the whole loop to finish.

### queryLoop

Core loop. It prepares messages, streams the model, detects tool requests, runs tools, appends results, updates state, and returns a structured terminal reason.

## Why Async Generators Matter

Use `async function*` or an equivalent event-stream abstraction when the user should see progress before the whole task completes.

Benefits:

- assistant text can appear as soon as the model emits it
- tool start and tool finish events can be surfaced immediately
- outer layers can forward inner events with `yield*`
- model generation time can overlap with tool execution time
- lifecycle cleanup can stay outside the core loop

Example event shape:

```ts
type QueryEvent =
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_started"; toolUseId: string; name: string }
  | { type: "tool_output"; toolUseId: string; output: string }
  | { type: "tool_finished"; toolUseId: string; result: ToolResult }
  | { type: "error"; reason: string }
```

## Five Steps Per Loop Iteration

Each loop iteration follows five steps:

```ts
async function* queryLoop(params) {
  let state = {
    messages: [...params.messages],
    turnCount: 1,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
  }

  while (true) {
    const messagesForQuery = prepareMessages(state)

    const modelResult = await streamModelAndCollectToolUses({
      messages: messagesForQuery,
      state,
      yieldEvent,
    })

    if (!modelResult.needsFollowUp) {
      return { reason: "completed", state }
    }

    const toolResults = await runTools(modelResult.toolUses, state)

    state = {
      ...state,
      messages: [
        ...messagesForQuery,
        modelResult.assistantMessage,
        toolResultsAsMessage(toolResults),
      ],
      turnCount: state.turnCount + 1,
      hasAttemptedReactiveCompact: false,
    }
  }
}
```

The five steps:

1. Prepare messages.
2. Stream the model response.
3. Decide whether to stop or continue.
4. Execute requested tools.
5. Append results and update state for the next iteration.

## Stop Or Continue Decision

Keep the core decision simple:

- If model output contains at least one `tool_use`, set `needsFollowUp = true`.
- If there are no `tool_use` blocks, return `completed`.

```ts
if (!needsFollowUp) {
  return { reason: "completed" }
}
```

Avoid adding a second intent classifier unless the product truly needs one. The model communicates its intent by emitting either normal text or structured tool requests.

## Terminal Reasons

Return structured terminal reasons instead of throwing unstructured errors.

Useful reasons:

```ts
type QueryTerminalReason =
  | "completed"
  | "max_turns"
  | "aborted_streaming"
  | "aborted_tools"
  | "prompt_too_long"
  | "max_output_tokens_recovery"
  | "stop_hook_prevented"
  | "image_error"
  | "tool_protocol_repair_failed"
  | "model_error"
```

For the calendar project, map these to local reasons in `calendar-error-recovery`.

## Explicit Cross-Turn State

Keep all cross-turn state in one object. Do not hide important counters and flags in scattered closures or globals.

```ts
type State = {
  messages: Message[]
  turnCount: number
  maxTurns?: number
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  pendingToolUseIds: Set<string>
  abortSignal?: AbortSignal
}
```

Important fields:

- `messages`: accumulated conversation and tool results
- `turnCount`: loop iteration count
- `maxTurns`: safety cap against runaway loops
- `maxOutputTokensRecoveryCount`: cap continuation attempts
- `hasAttemptedReactiveCompact`: avoid repeated compaction in the same failed request
- `pendingToolUseIds`: detect tool calls that still need matching results

This makes debugging easier because every reason the loop continues or stops is visible in state.

## Reactive Context Compaction

Do not eagerly compact every turn unless product constraints require it.

Preferred strategy:

1. Try the request with current messages.
2. If the API rejects with prompt-too-long or 413, compact.
3. Set `hasAttemptedReactiveCompact = true`.
4. Retry the same turn once.
5. If still too long, return `prompt_too_long`.

```ts
if (isPromptTooLong(error) && !state.hasAttemptedReactiveCompact) {
  state.hasAttemptedReactiveCompact = true
  state.messages = await compactMessages(state.messages)
  retryCurrentTurn()
}
```

In the calendar project, this idea maps to `/compat`, but automatic recovery can also reuse the same compaction rules.

## Tool Use And Tool Result Pairing

Many model tool protocols require every `tool_use` block to have a matching `tool_result` block.

If a tool call is emitted but execution is interrupted, skipped, or lost during fallback, synthesize an error result instead of leaving an orphaned tool call.

```ts
function createMissingToolResult(toolUse: ToolUse, reason: string): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    is_error: true,
    content: `Tool did not complete: ${reason}`,
  }
}
```

Use this when:

- streaming aborts after a tool request appears
- tool execution aborts
- a tool runner crashes
- model fallback leaves a tool call unexecuted
- a stop hook prevents tool execution after tool request emission

This keeps the next model request valid and lets the model reason about the failure.

## StreamingToolExecutor Pattern

Naive tool flow:

```text
wait for full model stream
-> collect all tool_use blocks
-> run tools
-> continue
```

Better flow:

```text
model streams
-> complete tool_use appears
-> start that tool immediately in background
-> keep reading model stream
-> collect all remaining results after stream ends
```

Minimal interface:

```ts
class StreamingToolExecutor {
  addTool(toolUse: ToolUse, assistantMessage: Message): void {
    // Start immediately if safe; queue if it mutates state.
  }

  async getRemainingResults(): Promise<ToolResult[]> {
    // Await pending executions and return all results.
  }
}
```

Mutability rule:

- read-only tools can run in parallel
- mutating tools must run serially
- unknown tools fail closed and are treated as mutating

```ts
type ToolDefinition = {
  name: string
  isReadOnly?: boolean
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}
```

This overlaps model generation time and tool execution time.

## Max Output Tokens Recovery

When model output is truncated:

1. If possible, silently retry with a larger output cap.
2. If still truncated, add a continuation nudge in the next model request.
3. Tell the model to resume directly with no apology or recap.
4. Cap continuation attempts, commonly at 3.
5. Return `max_output_tokens_recovery` if recovery fails.

Nudge example:

```text
Output token limit hit. Resume directly from where you left off. Do not apologize. Do not recap. Continue the remaining work in smaller chunks.
```

Implementation counter:

```ts
state.maxOutputTokensRecoveryCount += 1

if (state.maxOutputTokensRecoveryCount >= 3) {
  return { reason: "max_output_tokens_recovery", state }
}
```

## Abort Handling

Separate model-stream aborts from tool-execution aborts.

- `aborted_streaming`: user interrupts while the model is streaming
- `aborted_tools`: user interrupts while tools are running

On abort:

1. Stop accepting new chunks or tool requests.
2. Cancel pending tools if possible.
3. Synthesize error tool results for any unpaired `tool_use`.
4. Return structured terminal reason.
5. Keep message history valid so the next user input can continue.

## Stop Hooks

A stop hook is a user or project guard that prevents continuation.

Examples:

- require tests before final answer
- require lint before database write
- block destructive operations without approval
- enforce product-specific safety rules

Represent hook failure as `stop_hook_prevented` or a local structured reason.

## Applying To This Calendar Project

When using this reference for the calendar Agent:

- Map `ask` to the current request entry handler.
- Map `QueryEngine.submitMessage` to the single scheduling session state manager.
- Map `query` to the backend/frontend response stream or structured result wrapper.
- Map `queryLoop` to `calendar-main-loop`.
- Map `tool_use` to Agent requests for field extraction, tool queries, free-time search, conflict detection, or card revision.
- Map `tool_result` to structured results appended to `SchedulingSessionState`.
- Map reactive compaction to `/compat` and automatic prompt-too-long recovery.
- Map missing required scheduling fields to a structured stop, not a failed tool call.
- Map terminal reasons to `CalendarStopReason` in `calendar-error-recovery`.

## Testing Checklist

Test these behaviors when implementing a production loop:

- no tool/action request returns `completed`
- tool/action request causes one follow-up loop
- read-only tools can overlap safely
- mutating tools run serially
- unknown tool mutability runs serially
- `maxTurns` stops runaway loops
- prompt-too-long triggers one compaction retry
- prompt-too-long after compaction returns a terminal reason
- missing tool result is synthesized after abort
- tool failure becomes an error result
- output truncation triggers continuation recovery
- repeated truncation stops after the cap
- user abort during streaming is distinct from abort during tools
- state remains valid for the next user message

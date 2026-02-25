---
name: smithers-workflows
description: >
  Build and debug Smithers workflow engine pipelines (v0.8.5). Use when:
  (1) Writing or modifying workflow JSX (Workflow, Task, Sequence, Parallel, Ralph, Branch, Worktree)
  (2) Using the context API (ctx.output, ctx.outputMaybe, ctx.latest) - critical to get right
  (3) Defining Zod output schemas for tasks
  (4) Wiring props between components and MDX prompts
  (5) Building iterative loops with Ralph
  (6) Debugging data flow, missing outputs, or scheduler issues
  (7) Understanding the render-schedule-execute loop
---

# Smithers Workflow Engine

TypeScript framework for deterministic, resumable AI workflows defined as JSX.
Runtime: Bun >= 1.3. State: SQLite via Drizzle ORM. Validation: Zod schemas.

## The Core Loop

```
while true:
  1. Render   -> builder(ctx) -> HostElement tree -> TaskDescriptor[] + XML snapshot
  2. Schedule -> evaluate node states -> identify runnable tasks
  3. Execute  -> agent.generate() or compute/static payload
  4. Persist  -> validate against Zod -> write to SQLite -> emit events
  5. Re-render with updated ctx -> loop
```

Terminates when: no runnable tasks remain, a non-`continueOnFail` task fails, or `AbortSignal` fires.

## Context API - THE CRITICAL PART

Three methods for reading task outputs. Getting these wrong is the #1 source of bugs.

### `ctx.output(table, { nodeId, iteration? })` - THROWS

Looks for a row matching `nodeId` AND `iteration` (defaults to `ctx.iteration`).
**Throws** if no match. Use only when you're certain the task completed this iteration.

### `ctx.outputMaybe(table, { nodeId, iteration? })` - Safe, iteration-scoped

Same lookup as `output()` but returns `undefined` instead of throwing.
**Scoped to current iteration** - will NOT find outputs from prior Ralph iterations.

### `ctx.latest(table, nodeId)` - Cross-iteration, highest wins

Returns the row with the **highest iteration number** for that nodeId. Searches ALL iterations.
Returns `undefined` if no rows match.

### Decision Matrix

| Scenario | Method | Why |
|----------|--------|-----|
| Sequential pipeline (no Ralph) | `ctx.outputMaybe` | Only one iteration exists |
| Inside Ralph: reading prior stage output | `ctx.latest` | Output may be from earlier iteration |
| `skipIf` / `until` condition | `ctx.latest` | Must see across iterations |
| Checking if THIS iteration produced output | `ctx.outputMaybe` | Iteration-scoped is correct |
| Repeating global jobs (discovery) | `ctx.outputMaybe` with explicit `iteration` | `latest` would say "done forever" |

### Signature Differences (WATCH OUT)

```typescript
// outputMaybe: second arg is an OBJECT with nodeId
ctx.outputMaybe("research", { nodeId: "T-1:research" })

// latest: second arg is a plain STRING
ctx.latest("research", "T-1:research")

// WRONG - passing object to latest (silently returns undefined)
ctx.latest("research", { nodeId: "T-1:research" })  // BUG!
```

### Other Context Properties

| Property | Type | Description |
|----------|------|-------------|
| `ctx.runId` | `string` | Unique run identifier |
| `ctx.iteration` | `number` | Current Ralph iteration (0-indexed, always 0 outside Ralph) |
| `ctx.iterations` | `Record<string, number>` | Map of Ralph id -> current iteration |
| `ctx.input` | inferred from schema | Decoded input payload |
| `ctx.outputs(table)` | `Row[]` | ALL rows for a table across all iterations/nodeIds |
| `ctx.latestArray(value, schema)` | `any[]` | Safe JSON array parser for SQLite text columns |
| `ctx.iterationCount(table, nodeId)` | `number` | Count of distinct iterations with output |

## JSX Primitives

| Component | Purpose | Key Props |
|-----------|---------|-----------|
| `<Workflow>` | Root container (implicit Sequence) | `name`, `cache?` |
| `<Task>` | Unit of work | `id`, `output` (ZodObject), `agent?`, `retries?`, `skipIf?`, `continueOnFail?`, `timeoutMs?` |
| `<Sequence>` | Children run in order | `skipIf?` |
| `<Parallel>` | Children run concurrently | `maxConcurrency?`, `skipIf?` |
| `<Ralph>` | Loop until condition | `until`, `maxIterations?` (default 5), `onMaxReached?` ("fail"\|"return-last") |
| `<Branch>` | Conditional | `if`, `then`, `else?` |
| `<Worktree>` | Isolated git/jj worktree | `path`, `branch?`, `skipIf?` |
| `<MergeQueue>` | Like Parallel with maxConcurrency=1 | `maxConcurrency?` |

## Task Modes

`<Task>` operates in three modes based on children + agent:

```tsx
// Agent mode: agent present, children = prompt text
<Task id="analyze" output={outputs.analyze} agent={analyst}>
  {`Analyze this: ${ctx.input.description}`}
</Task>

// Compute mode: children is a function, no agent
<Task id="config" output={outputs.config}>
  {async () => {
    const data = await fetchSomething();
    return { key: data.value };
  }}
</Task>

// Static mode: children is a plain value, no agent
<Task id="tracker" output={outputs.tracker}>
  {{ count: 42, status: "running" }}
</Task>
```

**Critical**: If `agent` is undefined/falsy, the prompt string becomes `staticPayload` and gets validated against the output schema directly -> ZodError "expected object, received string". Always verify your agent is truthy.

## Schema Setup with createSmithers

```typescript
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Task, smithers, outputs, useCtx, db, tables } = createSmithers({
  research: z.object({ summary: z.string(), files: z.array(z.string()) }),
  implement: z.object({ whatWasDone: z.string(), filesModified: z.array(z.string()) }),
});

// outputs.research = the ZodObject itself (pass to Task's output prop)
// Use schema keys as first arg to ctx methods: ctx.latest("research", "my-node-id")
```

Schema rules:
- Use `.nullable()` never `.optional()` (OpenAI structured outputs rejects optional)
- Use explicit types, never `z.any()` (provides no JSON Schema guidance to agents)
- Schema keys become SQLite table names (camelCase -> snake_case)

## Workflow Patterns

### Sequential Pipeline

```tsx
export default smithers((ctx) => {
  const analysis = ctx.outputMaybe("analyze", { nodeId: "analyze" });
  return (
    <Workflow name="pipeline">
      <Task id="analyze" output={outputs.analyze} agent={analyst}>
        {`Analyze: ${ctx.input.description}`}
      </Task>
      {analysis && (
        <Task id="fix" output={outputs.fix} agent={fixer}>
          {`Fix: ${analysis.summary}`}
        </Task>
      )}
    </Workflow>
  );
});
```

### Ralph Iterative Loop

```tsx
const latestReview = ctx.latest("review", "review");
<Ralph until={latestReview?.approved === true} maxIterations={5} onMaxReached="return-last">
  <Sequence>
    <Task id="code" output={outputs.code} agent={coder}>
      {latestReview ? `Fix: ${latestReview.feedback}` : `Implement: ${ctx.input.spec}`}
    </Task>
    <Task id="review" output={outputs.review} agent={reviewer}>
      {`Review: ${ctx.latest("code", "code")?.source ?? ""}`}
    </Task>
  </Sequence>
</Ralph>
```

### Agent Fallback Arrays

```tsx
<Task
  id="implement"
  output={outputs.implement}
  agent={[primaryAgent, fallbackAgent]}  // attempt 1 -> primary, attempt 2+ -> fallback
  retries={3}
>
```

### Fire-and-Forget Background Tasks

```tsx
<Task id="monitor" output={outputs.monitor} continueOnFail={true}>
  {async () => {
    longRunningProcess().catch(() => {});  // DO NOT await
    return { started: true };
  }}
</Task>
```

## MDX Prompts

`.mdx` files are typed prompt templates. Enable via `mdxPlugin()` in Bun preload.

```tsx
import ResearchPrompt from "../prompts/Research.mdx";

<Task id="research" output={outputs.research} agent={agent}>
  <ResearchPrompt ticketId={id} files={files} context={priorOutput?.summary} />
</Task>
```

Inside MDX: `{props.ticketId}`, `{props.files.map(f => `- ${f}`).join('\n')}`.
Keep JSX expressions on single lines in MDX (multi-line ternaries can break parsing).

## References

For detailed documentation, read these reference files:
- [references/anti-patterns.md](references/anti-patterns.md) - Comprehensive DO/DON'T rules from real bugs
- [references/architecture.md](references/architecture.md) - Deep dive into engine internals, scheduler, type system
- [references/project-patterns.md](references/project-patterns.md) - Patterns from super-ralph-lite (selectors, job lifecycle, merge queue)

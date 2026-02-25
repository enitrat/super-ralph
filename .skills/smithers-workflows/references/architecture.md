# Smithers Architecture Deep Dive

## Architecture Layers

| Layer | Files | What it does |
|---|---|---|
| JSX Components | `src/components/` | Declarative execution graph via custom host elements |
| React Renderer | `src/dom/renderer.ts`, `src/dom/extract.ts` | Custom reconciler -> HostElement tree -> TaskDescriptor[] + XML snapshot |
| Engine | `src/engine/index.ts` | Core render->schedule->execute->persist loop |
| Scheduler | `src/engine/scheduler.ts` | Builds plan tree from XML, evaluates runnable tasks |
| Context | `src/context.ts` | Builds SmithersCtx each frame from persisted state |
| Database | `src/db/` | SQLite via Drizzle ORM |
| Tools | `src/tools/` | Sandboxed filesystem and shell tools |
| Agents | `src/agents/` | CLI-wrapped agents (ClaudeCode, Codex, Gemini, Pi, Kimi, Amp) |

## Scheduler Internals

### Plan Tree Construction (`buildPlanTree`)

Walks XML snapshot -> PlanNode tree:
- `smithers:task` -> `{ kind: "task", nodeId }`
- `smithers:workflow` / `smithers:sequence` -> `{ kind: "sequence", children }`
- `smithers:parallel` / `smithers:merge-queue` -> `{ kind: "parallel", children }`
- `smithers:ralph` -> `{ kind: "ralph", id, children, until, maxIterations }`

### Task Scheduling (`scheduleTasks`)

- **Sequence**: first non-terminal child only
- **Parallel**: all non-terminal children (capped by group `maxConcurrency`)
- **Ralph**: when all children terminal -> emits `readyRalphs` for iteration advance
- **Group**: all non-terminal children

Per-group concurrency: tracks `inProgress` count per `parallelGroupId`.

### Node State Machine

States: `pending` | `waiting-approval` | `in-progress` | `finished` | `failed` | `cancelled` | `skipped`

Determination order:
1. `skipIf === true` -> `skipped`
2. `needsApproval` -> check approval table
3. Has in-progress attempt -> `in-progress`
4. Valid output row exists -> `finished`
5. Inside completed Ralph loop -> `skipped`
6. Failed attempts >= `retries + 1` -> `failed`
7. Otherwise -> `pending`

## Task Execution

### Agent Tasks
1. Insert attempt row (state: `in-progress`)
2. Build prompt (user content + auto-appended JSON output instructions)
3. Call `agent.generate({ prompt, outputSchema, abortSignal })`
4. Extract JSON from response (tries multiple strategies: structured output -> raw JSON -> code-fenced -> balanced-brace -> last-object -> follow-up prompt)
5. Validate against Zod schema (up to 2 schema-retry prompts on mismatch)
6. Upsert into output table
7. Mark attempt as `finished`

### Task Children Resolution

When `agent` is present (agent mode):
- String children -> used as prompt directly
- React elements (including MDX) -> rendered via `renderToStaticMarkup` with markdown-producing components
- The prompt gets JSON output instructions prepended and appended

When no `agent` (compute mode):
- Function children -> invoked at execution time, return value validated against schema
- Object children -> static payload, written directly

## Context Construction

Context is rebuilt fresh every engine frame:

```typescript
const ctx = buildContext<Schema>({
  runId,
  iteration: defaultIteration,
  iterations: ralphIterationsObject(ralphState),
  input: inputRow,
  outputs,              // OutputSnapshot: { tableName: Row[] }
  zodToKeyName,         // Map<ZodObject, string> for reverse lookup
});
```

`outputs` is a flat map of table name -> all rows for this run. Lookup works by both camelCase schema key AND snake_case SQLite table name.

### output() vs outputMaybe() Row Matching

```
1. Filter rows where row.nodeId === key.nodeId
2. If table has iteration column: also match row.iteration === (key.iteration ?? ctx.iteration)
3. Return first match (output throws, outputMaybe returns undefined)
```

### latest() Row Matching

```
1. Filter rows where row.nodeId === nodeId (string, not object!)
2. Find the row with the largest iteration value
3. Return it (or undefined if no rows)
```

## Type System

### Schema Generic Parameter

`Schema` type propagates from `createSmithers<Schema>` through all APIs:

```typescript
type Schema = {
  analyze: z.ZodObject<{ summary: z.ZodString }>;
  fix: z.ZodObject<{ patch: z.ZodString }>;
};
// -> SmithersCtx<Schema>, SmithersWorkflow<Schema>, CreateSmithersApi<Schema>
```

### Key Types

```typescript
// OutputKey - used by output() and outputMaybe()
type OutputKey = { nodeId: string; iteration?: number };

// OutputAccessor - both callable and indexable
type OutputAccessor<Schema> = {
  <K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>;
} & {
  [K in keyof Schema & string]: Array<InferOutputEntry<Schema[K]>>;
};

// AgentLike - duck-typed agent interface
type AgentLike = {
  generate: (args: {
    prompt: string;
    outputSchema?: ZodObject<any>;
    abortSignal?: AbortSignal;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  }) => Promise<any>;
};

// TaskDescriptor - internal task representation after extraction
type TaskDescriptor = {
  nodeId: string;
  ordinal: number;
  iteration: number;
  ralphId?: string;
  worktreeId?: string;
  outputTable: any;
  outputSchema?: ZodObject<any>;
  agent?: AgentLike | AgentLike[];
  prompt?: string;
  staticPayload?: unknown;
  computeFn?: () => unknown | Promise<unknown>;
  // ... retries, timeoutMs, skipIf, continueOnFail, etc.
};
```

## Error Handling

### Task-Level

- **Retries**: `retries={N}` -> task stays pending while attempts < retries + 1
- **continueOnFail**: failed task treated as terminal (siblings proceed)
- **Agent fallback**: `agent={[A, B, C]}` -> attempt N uses `agents[min(N-1, length-1)]`
- **Schema retry**: If JSON parses but Zod fails, up to 2 auto-retry prompts with validation errors
- **Auth circuit breaker**: Agent disabled for rest of run on auth error (401, invalid_authentication)

### Stale Attempt Recovery

On resume: attempts in-progress > 15 minutes auto-cancelled and reset to pending.

## Default Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_MAX_CONCURRENCY` | 4 |
| `DEFAULT_TOOL_TIMEOUT_MS` | 30 min |
| `DEFAULT_MAX_OUTPUT_BYTES` | 200KB |
| `STALE_ATTEMPT_MS` | 15 min |
| `DEFAULT_MERGE_QUEUE_CONCURRENCY` | 1 |

## SmithersEvent Types

Events passed to `onProgress`:
- Run: `RunStarted`, `RunStatusChanged`, `RunFinished`, `RunFailed`, `RunCancelled`
- Frame: `FrameCommitted`
- Node: `NodePending`, `NodeStarted`, `NodeFinished`, `NodeFailed`, `NodeCancelled`, `NodeSkipped`, `NodeRetrying`
- Approval: `ApprovalRequested`, `ApprovalGranted`, `ApprovalDenied`
- Tool: `ToolCallStarted`, `ToolCallFinished`, `NodeOutput`
- HMR: `WorkflowReloadDetected`, `WorkflowReloaded`, `WorkflowReloadFailed`

## Available Agents

| Agent | CLI | Notes |
|-------|-----|-------|
| `ClaudeCodeAgent` | `claude` | Default researcher/reviewer |
| `CodexAgent` | `codex` | Default implementer |
| `GeminiAgent` | `gemini` | JSON output format by default |
| `KimiAgent` | `kimi` | thinking=true, text output by default |
| `AmpAgent` | `amp` | Supports threads, MCP configs |
| `PiAgent` | `pi` | Pi CLI |

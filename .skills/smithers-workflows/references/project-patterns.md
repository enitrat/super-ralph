# Super-Ralph-Lite Project Patterns

Opinionated patterns used in this project on top of base Smithers.

## Project Structure

```
src/
  schemas.ts          # All Zod output schemas + complexity tiers (single source of truth)
  selectors.ts        # ctx accessor functions (selectResearch, selectPlan, etc.)
  scheduledTasks.ts   # SQLite-backed job queue (separate from Smithers DB)
  durability.ts       # Cross-run ticket state via direct SQLite reads
  components/
    SuperRalph.tsx    # Root workflow component (Ralph loop + job dispatch)
    Job.tsx           # Per-job dispatcher (switches on jobType)
    TicketScheduler   # AI-driven job scheduler
    AgenticMergeQueue # AI-driven merge coordinator
    InterpretConfig   # Prompt -> config converter
  prompts/            # MDX prompt templates (12 files)
```

## Selector Layer

All `ctx` access goes through pure functions in `selectors.ts`. Never raw `ctx.latest` calls scattered through components.

```typescript
// selectors.ts
export function selectResearch(ctx, ticketId) {
  return ctx.latest("research", `${ticketId}:research`);
}

export function selectPlan(ctx, ticketId) {
  return ctx.latest("plan", `${ticketId}:plan`);
}

export function selectImplement(ctx, ticketId) {
  return ctx.latest("implement", `${ticketId}:implement`);
}
// ... etc for all 10+ pipeline stages
```

**Convention**: Single place to change output key naming. All pipeline stages follow the same pattern.

## Node ID Convention

| Task Type | Node ID Pattern | Example |
|-----------|----------------|---------|
| Global/singleton | Task's `id` directly | `"ticket-scheduler"`, `"interpret-config"` |
| Per-ticket stage | `{ticketId}:{stage}` | `"T-1:research"`, `"T-1:implement"` |

This convention is rigid and used throughout all pipeline stages and selectors.

## Complexity Tier System

Tickets are assigned a tier at discovery time. The tier determines which stages run:

```typescript
const COMPLEXITY_TIERS = {
  trivial: ["implement", "build-verify"],
  small:   ["implement", "test", "build-verify"],
  medium:  ["research", "plan", "implement", "test", "build-verify", "code-review"],
  large:   ["research", "plan", "implement", "test", "build-verify", "spec-review", "code-review", "review-fix", "report"],
};
```

`isTicketTierComplete()` checks if the final stage for a tier has output in ctx.

## Two-Database Architecture

1. **Smithers DB** (`.super-ralph/workflow.db`) - All task outputs, system tables
2. **Scheduled Tasks DB** (`scheduled-tasks.db`) - Active job queue

Smithers has no native job queue concept, so a separate SQLite table tracks active jobs.

## Job Lifecycle in SuperRalph

1. On each Ralph iteration, read `schedulerOutput` from `ctx.latest("ticket_schedule", "ticket-scheduler")`
2. For each job in output: check `isJobComplete(ctx, job)`, insert if not done
3. Render `activeJobs.map(job => <Job key={job.jobId} .../>)`
4. Only run `<TicketScheduler>` when `activeCount < maxConcurrency`

```typescript
export function isJobComplete(ctx, job) {
  const outputKey = JOB_TYPE_TO_OUTPUT_KEY[job.jobType];
  if (!outputKey) return false;
  // Use latest for one-shot pipeline stages, outputMaybe for repeating jobs
  return !!ctx.latest(outputKey, job.jobId);
}
```

## Shared jobProps Pattern

`SuperRalph` assembles a shared `jobProps` object to avoid repeating prop drilling:

```typescript
const jobProps = {
  ctx, outputs, retries: taskRetries,
  ticketMap, focusMap,
  projectName, specsPath, referenceFiles, buildCmds, testCmds,
  codeStyle, reviewChecklist, progressFile, findingsFile,
  prefix, mainBranch, completedTicketIds, unfinishedTickets,
};

{activeJobs.map(job => (
  <Job key={job.jobId} job={job} agent={resolveAgent(pool, job.agentId)} {...jobProps} />
))}
```

## Worktree Isolation

Every job runs inside a `<Worktree>`:

```typescript
function wrapWorktree(id: string, child: React.ReactElement) {
  return <Worktree id={`wt-${id}`} path={`/tmp/workflow-wt-${id}`}>{child}</Worktree>;
}
```

Uses `job.jobId` as worktree ID (must be unique per job instance).

## Data Flow Between Stages

Each stage reads previous outputs via selectors and passes to MDX prompts:

```typescript
const researchData = selectResearch(ctx, ticket.id);
const planData     = selectPlan(ctx, ticket.id);
const latestImpl   = selectImplement(ctx, ticket.id);
const latestTest   = selectTestResults(ctx, ticket.id);

<ImplementPrompt
  planFilePath={planData?.planFilePath ?? `docs/plans/${ticket.id}.md`}
  implementationSteps={planData?.implementationSteps ?? null}
  previousImplementation={latestImpl ?? null}
  reviewFeedback={reviewFeedback}
  failingTests={latestTest?.failingSummary ?? null}
  evictionContext={evictionContext}
/>
```

## Configuration Flow

```
CLI args -> promptText -> [clarification Q&A] -> clarificationSession
                                                   |
                          InterpretConfig Task (AI) -> SuperRalphConfig
                                                   |
                    SuperRalph gets config via {...getInterpretedConfig(ctx)}
```

`getInterpretedConfig(ctx)` reads from context and throws if missing:
```typescript
function getInterpretedConfig(ctx) {
  const config = ctx.latest("interpret_config", "interpret-config");
  if (!config) throw new Error("InterpretConfig did not produce output");
  return config;
}
```

## Workflow File Generation

The CLI generates a `.tsx` workflow file at runtime, baking constants as JS literals:

```typescript
const REPO_ROOT = "/absolute/path/to/repo";
const DB_PATH = "/absolute/path/to/.super-ralph/workflow.db";
// ...
export default smithers((ctx) => (
  <Workflow name="super-ralph-full">
    <Sequence>
      <InterpretConfig ... />
      <Parallel>
        <SuperRalph ctx={ctx} outputs={outputs} repoRoot={REPO_ROOT} ... />
        <Monitor ... />
      </Parallel>
    </Sequence>
  </Workflow>
));
```

## Durability and Cross-Run State

`durability.ts` reads Smithers DB directly (bypassing ctx) for cross-run ticket state:

```typescript
function getResumableTickets(dbPath, currentRunId) {
  const allState = loadCrossRunTicketState(dbPath);
  return allState.filter(t => !t.landed && t.latestRunId !== currentRunId);
}
```

The scheduler receives `resumableTickets` as a prop and prioritizes them.

## Eviction Context Threading

When a ticket is evicted from the merge queue, the eviction context (reason, diff, log) is stored in the `land` output schema and threaded back into Research/Plan/Implement prompts on the next pipeline attempt.

## MDX Type Generation

`scripts/gen-mdx-types.ts` auto-generates `src/mdx.d.ts` from MDX AST, enabling TypeScript type checking on prompt props. Run via `bun run gen:mdx-types`.

## Background Monitor Pattern

The Monitor runs alongside SuperRalph in a `<Parallel>` using fire-and-forget + `continueOnFail`:

```tsx
<Parallel>
  <SuperRalph ... />
  <Monitor dbPath={DB_PATH} runId={ctx.runId} ... />
</Parallel>
```

Monitor Task uses `continueOnFail={true}` and does NOT await the polling loop.

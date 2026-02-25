# Super-Ralph-Lite Architecture

Complete technical documentation of the pipeline. No secrets.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Full Lifecycle of a Run](#2-full-lifecycle-of-a-run)
3. [The Ralph Loop: How Iterations Work](#3-the-ralph-loop-how-iterations-work)
4. [Ticket Discovery](#4-ticket-discovery)
5. [The Scheduler](#5-the-scheduler)
6. [Job Lifecycle](#6-job-lifecycle)
7. [Per-Ticket Pipeline Stages](#7-per-ticket-pipeline-stages)
8. [Complexity Tiers](#8-complexity-tiers)
9. [Data Flow Between Stages](#9-data-flow-between-stages)
10. [The Merge Queue](#10-the-merge-queue)
11. [jj Integration](#11-jj-integration)
12. [Worktree System](#12-worktree-system)
13. [Cross-Run Durability](#13-cross-run-durability)
14. [The Monitor](#14-the-monitor)
15. [Two-Database Architecture](#15-two-database-architecture)
16. [Agent Configuration](#16-agent-configuration)
17. [Configuration Flow](#17-configuration-flow)

---

## 1. System Overview

Super-Ralph-Lite is a multi-agent AI development pipeline built on the Smithers workflow engine. It takes a natural language prompt describing work to be done on a codebase, breaks it into tickets, and runs each ticket through a configurable pipeline of AI agents (research, plan, implement, test, review, land).

```
User prompt
  → Clarifying questions (interactive TUI)
  → InterpretConfig (AI generates structured config)
  → SuperRalph loop:
      → TicketScheduler (AI decides what to run next)
      → Parallel pipeline jobs (research/plan/implement/test/review per ticket)
      → AgenticMergeQueue (AI lands completed tickets via jj)
      → Repeat until all tickets landed
```

### Key Technologies

| Layer | Technology |
|-------|-----------|
| Workflow engine | Smithers (JSX-based, React reconciler) |
| Runtime | Bun >= 1.3 |
| Database | SQLite (via Drizzle ORM for Smithers, raw bun:sqlite for job queue) |
| Schema validation | Zod |
| VCS | jj (Jujutsu) exclusively, no git fallback |
| Prompt templates | MDX (compiled via Bun preload plugin) |
| Agents | ClaudeCodeAgent (claude-sonnet-4-6), CodexAgent (gpt-5.3-codex) |

### Project Structure

```
src/
  cli/
    index.ts                 # CLI entry point, workflow file generation, Smithers launch
    clarifications.ts        # Hardcoded fallback clarification questions
    interactive-questions.ts # Full-screen TUI for answering questions
  components/
    SuperRalph.tsx           # Root workflow: Ralph loop + job dispatch + merge queue
    Job.tsx                  # Per-job dispatcher (switches on jobType)
    TicketScheduler.tsx      # AI-driven job scheduler
    AgenticMergeQueue.tsx    # AI-driven merge coordinator
    InterpretConfig.tsx      # Prompt → structured config converter
    ClarifyingQuestions.tsx  # Smithers-based Q&A (unused by CLI path)
    Monitor.tsx              # Background TUI launcher
    TicketResume.tsx         # Cross-run resume helper
  prompts/                   # 12 MDX prompt templates
    Discover.mdx, Research.mdx, Plan.mdx, Implement.mdx, Test.mdx,
    BuildVerify.mdx, SpecReview.mdx, CodeReview.mdx, ReviewFix.mdx,
    Report.mdx, Land.mdx, UpdateProgress.mdx
  schemas.ts                 # All Zod output schemas + complexity tier definitions
  selectors.ts               # Pure functions for reading ctx (selectResearch, selectPlan, etc.)
  scheduledTasks.ts          # SQLite-backed job queue (separate from Smithers DB)
  durability.ts              # Cross-run ticket state via direct SQLite reads
  mergeQueue/
    coordinator.ts           # Programmatic speculative merge queue (alternative to agentic)
  advanced-monitor-ui.ts     # OpenTUI-based terminal dashboard
```

---

## 2. Full Lifecycle of a Run

### Phase 1: CLI Startup (`src/cli/index.ts`)

1. **Parse arguments**: Hand-written parser. Flags: `--cwd`, `--max-concurrency`, `--run-id`, `--resume`, `--dry-run`, `--skip-questions`. Prompt is positional (inline text, file path, or stdin via `"-"`).

2. **Detect agents**: Runs `which claude`, `which codex`, `which gh` in parallel. If neither claude nor codex found, throws immediately.

3. **Build fallback config**: Scans repo for `package.json` scripts, `go.mod`, `Cargo.toml`. Builds `buildCmds`/`testCmds` maps, finds `specsPath`.

### Phase 2: Clarifying Questions (Pre-Smithers)

Runs entirely before the Smithers workflow launches.

1. **Generate questions**: First tries Anthropic API directly (`claude-opus-4-6`), asking for 10-15 product-focused questions. Falls back to `claude --print`, then to 12 hardcoded questions in `clarifications.ts`.

2. **Interactive TUI**: Questions written to `.super-ralph/temp/questions-{uuid}.json`. `interactive-questions.ts` spawns a full-screen terminal UI (ANSI escape codes, no framework). Arrow keys navigate, Enter confirms, Left/Right jump between questions, "F" to finish early.

3. **Session construction**: Answers assembled into `{ answers, summary }` where summary is a numbered Q&A string. This object gets JSON-serialized into the generated workflow.

### Phase 3: Generate Workflow File

`renderWorkflowFile()` emits a complete `.tsx` file to `.super-ralph/generated/workflow.tsx`. All runtime constants are baked in as JS literals: `REPO_ROOT`, `DB_PATH`, `PROMPT_TEXT`, `CLARIFICATION_SESSION`, `FALLBACK_CONFIG`, `PACKAGE_SCRIPTS`, agent availability flags.

Import prefix detection:
- Target repo IS super-ralph → `../../src` (relative)
- Running FROM super-ralph source for another repo → absolute path
- Running from installed package → `super-ralph`

### Phase 4: Launch Smithers

```typescript
const proc = Bun.spawn(["bun", "--no-install", "-r", preloadPath, smithersCliPath, "run", workflowPath,
  "--root", repoRoot, "--run-id", runId, "--max-concurrency", String(maxConcurrency)], {
  cwd: execCwd,
  env: { ...process.env, USE_CLI_AGENTS: "1", SMITHERS_DEBUG: "1" },
});
```

`CLAUDECODE` env var is explicitly deleted. Preload registers the MDX plugin.

### Phase 5: Generated Workflow Execution

The generated workflow has this exact structure:

```tsx
export default smithers((ctx) => (
  <Workflow name="super-ralph-full">
    <Sequence>
      {/* Step 1: AI interprets user prompt into structured config */}
      <InterpretConfig
        prompt={PROMPT_TEXT}
        clarificationSession={CLARIFICATION_SESSION}
        repoRoot={REPO_ROOT}
        fallbackConfig={FALLBACK_CONFIG}
        packageScripts={PACKAGE_SCRIPTS}
        detectedAgents={{ claude: HAS_CLAUDE, codex: HAS_CODEX, gh: false }}
        agent={planningAgent}
      />

      {/* Step 2: Main pipeline + monitor run concurrently */}
      <Parallel>
        <SuperRalph
          ctx={ctx}
          outputs={outputs}
          repoRoot={REPO_ROOT}
          {...getInterpretedConfig(ctx)}   // spreads InterpretConfig output as props
          agents={{
            planning: { agent: planningAgent, description: "Plan and research next tickets." },
            implementation: { agent: implementationAgent, description: "..." },
            testing: { agent: testingAgent, description: "..." },
            reviewing: { agent: reviewingAgent, description: "..." },
            reporting: { agent: reportingAgent, description: "..." },
          }}
        />
        <Monitor dbPath={DB_PATH} runId={ctx.runId} config={getInterpretedConfig(ctx)} ... />
      </Parallel>
    </Sequence>
  </Workflow>
));
```

`getInterpretedConfig(ctx)` reads the InterpretConfig output from Smithers' database:
```typescript
function getInterpretedConfig(ctx: any) {
  const config = ctx.latest("interpret_config", "interpret-config");
  if (!config) throw new Error("InterpretConfig did not produce output");
  return config;
}
```

The `<Sequence>` ensures InterpretConfig completes before SuperRalph starts. The `<Parallel>` runs SuperRalph and Monitor concurrently.

---

## 3. The Ralph Loop: How Iterations Work

SuperRalph wraps everything in:

```tsx
<Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
  <Parallel maxConcurrency={maxConcurrency}>
    {/* TicketScheduler (conditional) */}
    {/* Active Jobs */}
    {/* AgenticMergeQueue (conditional) */}
  </Parallel>
</Ralph>
```

### What "iteration" means

A Ralph iteration is one complete cycle of the Smithers render-schedule-execute loop. On each iteration:

1. **Render**: The builder function runs. `SuperRalph` reads all current state from Smithers context (discovered tickets, pipeline stages, completed tickets, scheduler output). It opens the scheduled-tasks DB, reaps completed jobs, reconciles new jobs, reads active jobs, then renders JSX children.

2. **Schedule**: Smithers evaluates which tasks within the `<Parallel>` are runnable (pending + under concurrency limit).

3. **Execute**: Runnable tasks execute (agent prompts sent, compute functions called).

4. **Persist**: Outputs validated against Zod schemas, written to SQLite.

5. **Re-render**: The builder runs again with updated context. New tasks may appear (if a scheduler output created new jobs) or disappear (if jobs completed).

### When does a new iteration start?

A new Ralph iteration starts when ALL tasks within the current iteration have reached a terminal state (finished, failed, skipped, or cancelled). Since SuperRalph uses `<Parallel>`, all active jobs run concurrently, and the iteration advances only when every parallel child completes.

### Termination

`until={false}` means the loop never terminates via its condition. The workflow terminates when Smithers detects that a Ralph iteration produced no runnable tasks and no pending work remains. In practice this happens when:
- All tickets are landed (`completedTicketIds` covers everything)
- `activeJobs` is empty
- The scheduler produces no new jobs
- The merge queue has no ready tickets

---

## 4. Ticket Discovery

### Trigger

The `TicketScheduler` (an AI agent) schedules a `"discovery"` job when the pipeline needs more tickets. Its scheduling rules include: "If active tickets <= maxConcurrency * 2, schedule a discovery job."

### Execution

`Job.tsx` renders the `"discovery"` case:

```tsx
case "discovery":
  return wrapWorktree(job.jobId,
    <Task id={job.jobId} output={outputs.discover} agent={agent} retries={retries}>
      <DiscoverPrompt
        projectName={projectName}
        specsPath={specsPath}
        referenceFiles={referenceFiles}
        categories={focuses}
        completedTicketIds={completedTicketIds}
        existingTickets={unfinishedTickets.map(t => ({
          id: t.id, title: t.title, complexityTier: t.complexityTier,
          pipelineStage: computePipelineStage(ctx, t.id),
        }))}
        previousProgress={progressSummary}
      />
    </Task>
  );
```

### What the agent does

`Discover.mdx` instructs the agent to:
1. Read specs from `specsPath`
2. Browse the codebase and reference files
3. Generate 3-5 new tickets, each with: `id`, `title`, `description`, `category`, `priority`, `complexityTier`, `acceptanceCriteria`, `relevantFiles`, `referenceFiles`

### Deduplication

The prompt includes `existingTickets` (in-progress) and `completedTicketIds` (landed). The agent is instructed: "Do NOT create a ticket if an existing ticket covers the same scope."

### Output schema

```typescript
discover: z.object({
  tickets: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string(),
    priority: z.enum(["critical", "high", "medium", "low"]),
    complexityTier: z.enum(["trivial", "small", "medium", "large"]),
    acceptanceCriteria: z.array(z.string()).nullable(),
    relevantFiles: z.array(z.string()).nullable(),
    referenceFiles: z.array(z.string()).nullable(),
  })),
  reasoning: z.string(),
  completionEstimate: z.string(),
})
```

### How discovered tickets become available

`selectDiscoverTickets()` reads ALL `discover` output rows, sorts by iteration ascending, deduplicates by ticket ID (latest iteration wins), and returns the merged list. This happens every Ralph iteration during render.

---

## 5. The Scheduler

### What it is

`TicketScheduler` is a Smithers `<Task>` (id: `"ticket-scheduler"`) that runs whenever `activeCount < maxConcurrency`. It is an AI agent that decides what jobs to schedule next.

### What context it receives

The scheduler prompt includes:
- Current time, pipeline summary (completed/active/concurrency counts)
- Currently running jobs table (jobId, type, agent, ticketId, age in minutes)
- Ticket state table (ID, title, priority, tier, current pipeline stage, stage status, next stages, landed flag, tier-done flag)
- Agent pool table (ID and description)
- Focus areas list
- Resumable tickets from prior runs (if any)
- Full tier pipeline reference
- 11 scheduling rules

### The 11 scheduling rules

1. Fill all free concurrency slots
2. Resume in-progress tickets first
3. Schedule the correct next stage for each ticket's tier
4. Load balance across focus areas
5. Keep the pipeline full (schedule discovery when starved)
6. Handle rate-limited agents (spread work to others)
7. No double-scheduling (don't schedule a job that's already running)
8. Maximize cheap agents (prefer codex for implementation)
9. Conditional review-fix (only if review returned severity > "none")
10. Respect tier completion (don't schedule stages beyond a ticket's tier)
11. Handle failed stages (re-schedule or escalate)

### Output schema

```typescript
ticketScheduleSchema = z.object({
  jobs: z.array(z.object({
    jobId: z.string(),        // e.g. "T-1:research", "discovery"
    jobType: z.enum(JOB_TYPES),
    agentId: z.string(),      // key in agent pool
    ticketId: z.string().nullable(),
    focusId: z.string().nullable(),
    reason: z.string(),
  })),
  reasoning: z.string(),
  rateLimitedAgents: z.array(z.object({
    agentId: z.string(),
    resumeAtMs: z.number(),
  })),
})
```

### How scheduler output becomes running jobs

SuperRalph reads the scheduler output on every render:
```typescript
const schedulerOutput = ctx.latest("ticket_schedule", "ticket-scheduler");
if (schedulerOutput?.jobs) {
  for (const job of schedulerOutput.jobs) {
    if (!isJobComplete(ctx, job)) {
      insertJob(db, job);  // INSERT OR IGNORE into scheduled_tasks.db
    }
  }
}
```

---

## 6. Job Lifecycle

### The reconciliation loop (every Ralph iteration)

```
1. REAP:      For each job in scheduled_tasks DB, if isJobComplete(ctx, job) → removeJob(db, jobId)
2. RECONCILE: For each job in latest scheduler output, if !isJobComplete → insertJob(db, job)
3. READ:      activeJobs = getActiveJobs(db) (ordered by creation time)
4. RENDER:    activeJobs.map(job => <Job key={job.jobId} agent={resolveAgent(pool, job.agentId)} .../>)
```

### `isJobComplete`

Maps `jobType` to a Smithers output key via `JOB_TYPE_TO_OUTPUT_KEY`, then checks `ctx.latest(outputKey, job.jobId)`:

```typescript
const JOB_TYPE_TO_OUTPUT_KEY = {
  "discovery":         "discover",
  "progress-update":   "progress",
  "ticket:research":   "research",
  "ticket:plan":       "plan",
  "ticket:implement":  "implement",
  "ticket:test":       "test_results",
  "ticket:build-verify": "build_verify",
  "ticket:spec-review":  "spec_review",
  "ticket:code-review":  "code_review",
  "ticket:review-fix":   "review_fix",
  "ticket:report":       "report",
};
```

If a Smithers output row exists for that (outputKey, jobId) pair, the job is done.

### Job types

| Job Type | Scope | Node ID | Description |
|----------|-------|---------|-------------|
| `discovery` | Global | `"discovery"` | Find new tickets from specs/codebase |
| `progress-update` | Global | `"progress-update"` | Update PROGRESS.md |
| `ticket:research` | Per-ticket | `{ticketId}:research` | Gather context, write context file |
| `ticket:plan` | Per-ticket | `{ticketId}:plan` | Create TDD implementation plan |
| `ticket:implement` | Per-ticket | `{ticketId}:implement` | Write code following the plan |
| `ticket:test` | Per-ticket | `{ticketId}:test` | Run test suites, fix failures |
| `ticket:build-verify` | Per-ticket | `{ticketId}:build-verify` | Run builds, fix compilation errors |
| `ticket:spec-review` | Per-ticket | `{ticketId}:spec-review` | Check spec compliance |
| `ticket:code-review` | Per-ticket | `{ticketId}:code-review` | Check code quality |
| `ticket:review-fix` | Per-ticket | `{ticketId}:review-fix` | Fix review issues |
| `ticket:report` | Per-ticket | `{ticketId}:report` | Final status report |

---

## 7. Per-Ticket Pipeline Stages

Each stage reads prior stage outputs via selectors and passes relevant data as MDX prompt props.

### Stage: research

**Reads**: nothing (first stage)
**Produces**: `{ contextFilePath: string, summary: string }`
**Agent does**: Read specs, reference materials, codebase. Write a context file at `docs/context/{ticketId}.md`. Commit with jj.

### Stage: plan

**Reads**: `selectResearch()` → contextFilePath, summary
**Produces**: `{ planFilePath: string, implementationSteps: string[] | null }`
**Agent does**: Read context file. Create TDD-ordered implementation plan at `docs/plans/{ticketId}.md`. Commit.

### Stage: implement

**Reads**: `selectPlan()` → planFilePath, implementationSteps; `selectImplement()` → previous attempt; `selectTestResults()` → failing tests; `selectCodeReviews()` → review feedback; `selectLand()` → eviction context
**Produces**: `{ whatWasDone: string, filesCreated: string[] | null, filesModified: string[] | null, nextSteps: string | null }`
**Agent does**: Follow TDD (write failing tests first, then implementation, then refactor). Commit and push to `ticket/{ticketId}` branch.

### Stage: test

**Reads**: nothing directly (runs commands in worktree)
**Produces**: `{ goTestsPassed, rustTestsPassed, e2eTestsPassed, sqlcGenPassed: boolean, failingSummary: string | null }`
**Agent does**: Run all test suites. Fix failures atomically. Commit.

### Stage: build-verify

**Reads**: `selectImplement()` → filesCreated, filesModified, whatWasDone
**Produces**: `{ buildPassed: boolean, errors: string[] | null }`
**Agent does**: Run all build steps. Fix compilation errors. Commit.

### Stage: spec-review

**Reads**: `selectImplement()`, `selectTestResults()`
**Produces**: `{ severity: "none"|"minor"|"major"|"critical", feedback: string, issues: string[] | null }`
**Agent does**: Read every modified/created file. Check spec compliance. Report severity.

### Stage: code-review

**Reads**: `selectImplement()` → filesCreated, filesModified
**Produces**: `{ severity: "none"|"minor"|"major"|"critical", feedback: string, issues: string[] | null }`
**Agent does**: Read every modified/created file. Check code quality (error handling, security, style, test coverage, performance, architecture). Report severity.

Three output schema variants exist: `code_review`, `code_review_codex`, `code_review_gemini`. `selectCodeReviews()` merges all three into worst-severity aggregate.

### Stage: review-fix

**Only scheduled when**: review returned severity > "none" (scheduler rule 9)
**Reads**: `selectSpecReview()`, `selectCodeReviews()` → all issues
**Produces**: `{ allIssuesResolved: boolean, summary: string }`
**Agent does**: Address every issue using TDD. Commit each fix atomically.

### Stage: report

**Reads**: all previous stages
**Produces**: `{ ticketId, status: "partial"|"complete"|"blocked", summary, filesChanged, testsAdded, reviewRounds, struggles, lessonsLearned }`
**Agent does**: Verify acceptance criteria. Confirm tests pass. Produce final status.

---

## 8. Complexity Tiers

Tickets are assigned a tier at discovery time. The tier determines which pipeline stages run:

| Tier | Stages | Final Stage |
|------|--------|-------------|
| `trivial` | implement → build-verify | build-verify |
| `small` | implement → test → build-verify | build-verify |
| `medium` | research → plan → implement → test → build-verify → code-review | code-review |
| `large` | research → plan → implement → test → build-verify → spec-review → code-review → review-fix → report | report |

### Tier completion check

`isTicketTierComplete()` checks only the **final required stage** for the ticket's tier. A trivial ticket is tier-complete as soon as `build_verify` output exists. A large ticket requires `report` output.

### Tier enforcement

Tier enforcement is **prompt-level only**. The scheduler is given explicit tier pipeline tables and told not to schedule stages outside a ticket's tier. The system does not hard-enforce this in code.

---

## 9. Data Flow Between Stages

All `ctx` access goes through pure functions in `selectors.ts`. Never raw `ctx.latest` calls scattered through components.

### Selector reference

| Selector | Output Key | Node ID Pattern |
|----------|-----------|-----------------|
| `selectDiscoverTickets(ctx)` | `discover` | `"discovery"` (all rows merged) |
| `selectResearch(ctx, id)` | `research` | `{id}:research` |
| `selectPlan(ctx, id)` | `plan` | `{id}:plan` |
| `selectImplement(ctx, id)` | `implement` | `{id}:implement` |
| `selectTestResults(ctx, id)` | `test_results` | `{id}:test` |
| `selectSpecReview(ctx, id)` | `spec_review` | `{id}:spec-review` |
| `selectCodeReviews(ctx, id)` | `code_review` + variants | `{id}:code-review` + variants |
| `selectLand(ctx, id)` | `land` then `merge_queue_result` | `{id}:land` or scan |
| `selectTicketPipelineStage(ctx, id)` | all stages (reverse walk) | returns stage name string |
| `selectCompletedTicketIds(ctx, tickets)` | calls `selectLand` | returns IDs where `merged === true` |

### Data threading chain

```
Research → {contextFilePath, summary}
    ↓
Plan → reads contextFilePath → {planFilePath, implementationSteps}
    ↓
Implement → reads planFilePath, implementationSteps, failingTests, reviewFeedback, evictionContext
    ↓            → {whatWasDone, filesCreated, filesModified}
Test → runs commands → {testsPassed, failingSummary}
    ↓
BuildVerify → reads filesCreated, filesModified → {buildPassed, errors}
    ↓
SpecReview → reads filesCreated, filesModified, testResults → {severity, feedback, issues}
    ↓
CodeReview → reads filesCreated, filesModified → {severity, feedback, issues}
    ↓
ReviewFix → reads all review issues → {allIssuesResolved, summary}
    ↓
Report → reads all prior data → {status, summary, lessonsLearned}
    ↓
MergeQueue → reads filesCreated, filesModified, worktreePath → land/evict
```

### Eviction context threading

When a ticket is evicted from the merge queue, `formatEvictionContext()` extracts the reason, details, attempted commit log, diff summary, and mainline changes since branch point. This is injected into Research, Plan, and Implement prompts on the next pipeline attempt so the agent can address the root cause.

---

## 10. The Merge Queue

Two implementations exist. Only the agentic one is used in the current workflow.

### AgenticMergeQueue (active)

Renders when `mergeQueueTickets.length > 0` (any ticket is tierComplete && !landed).

The agent receives:
- Queue status table (ticketId, title, priority, reportComplete, landed, filesModified)
- File overlap analysis (which files are touched by multiple tickets)
- Pre-land checks (commands to run in worktree before merge)
- Post-land CI checks (commands to run after rebase)
- Detailed jj merge instructions

**Merge flow per ticket** (priority order: critical > high > medium > low):
1. Run pre-land checks in the ticket's worktree
2. `jj rebase -b bookmark("ticket/{ticketId}") -d {mainBranch}`
3. Run post-land CI checks
4. `jj bookmark set {mainBranch} -r bookmark("ticket/{ticketId}")` (fast-forward)
5. `jj git push --bookmark {mainBranch}`
6. `jj bookmark delete ticket/{ticketId}` + cleanup worktree

**On failure**: Trivially resolvable conflicts (lockfiles, generated code) are resolved inline. Complex conflicts or CI failures evict the ticket with full context.

**Output schema** (`merge_queue_result`):
```typescript
z.object({
  ticketsLanded: z.array(z.object({ ticketId, mergeCommit, summary })),
  ticketsEvicted: z.array(z.object({ ticketId, reason, details })),
  ticketsSkipped: z.array(z.object({ ticketId, reason })),
  summary: z.string(),
  nextActions: z.string().nullable(),
})
```

### SpeculativeMergeQueueCoordinator (programmatic, alternative)

A non-LLM TypeScript implementation in `src/mergeQueue/coordinator.ts`. Not currently wired into the workflow but exported for potential use.

**Speculative execution**: Works on a sliding window of `maxSpeculativeDepth` tickets. Each ticket in the window is rebased on top of the previous one (stacked). CI runs in parallel on all speculative branches. If all pass, fast-forward main to the tail. If ticket N fails, land tickets 0..N-1, evict N, mark N+1..end as invalidated.

**Post-rebase review gate**: Optional LLM review of rebased diffs to catch semantic issues that clean file-level merges miss.

**Three ordering strategies**:
- `"priority"` — by ticket priority
- `"ticket-order"` — by positional order
- `"report-complete-fifo"` (default) — by when the report completed

---

## 11. jj Integration

The entire VCS layer uses jj exclusively. No git fallback.

### Bookmark convention

Each ticket gets a bookmark named `ticket/{ticketId}`. Used throughout:
```
jj bookmark set ticket/T-1 -r @
jj git push --bookmark ticket/T-1
```

### Commands used by stage

**Agent commits (research/plan/implement/test/build-verify/review-fix)**:
```bash
jj describe -m "emoji scope: message"
jj new
jj bookmark set ticket/{ticketId} -r @
jj git push --bookmark ticket/{ticketId}
```

**Merge queue landing**:
```bash
jj git fetch
jj rebase -b bookmark("ticket/{ticketId}") -d main
jj bookmark set main -r bookmark("ticket/{ticketId}")
jj git push --bookmark main
jj bookmark delete ticket/{ticketId}
```

**Eviction context collection**:
```bash
jj log -r main..bookmark("ticket/{ticketId}") --reversed        # attempted commits
jj diff -r roots(main..bookmark("ticket/{ticketId}")) --summary  # attempted changes
jj log -r bookmark("ticket/{ticketId}")..main --reversed          # what landed since branch
```

**Speculative CI workspaces** (programmatic coordinator):
```typescript
workspaceAdd(workspaceName, workspacePath, { cwd: repoRoot, atRev: bookmarkRev(ticketId) });
// ... run CI commands in workspace ...
workspaceClose(workspaceName, { cwd: repoRoot });
```

### Colocation

The project assumes jj colocated mode (`jj git init --colocate`). `jj git push` and `jj git fetch` bridge to the remote git repository.

---

## 12. Worktree System

### How worktrees are created

Every job runs inside a Smithers `<Worktree>` component:

```typescript
function wrapWorktree(id: string, child: React.ReactElement) {
  return <Worktree id={`wt-${id}`} path={`/tmp/workflow-wt-${id}`}>{child}</Worktree>;
}
```

When Smithers renders a `<Worktree>` node, it creates a jj workspace at the given path. The `cwd` for the agent's `<Task>` is set to the worktree path.

### Path convention

| Job Type | Worktree ID | Path |
|----------|-------------|------|
| Per-ticket pipeline | `wt-{ticketId}` | `/tmp/workflow-wt-{ticketId}` |
| Discovery | `wt-{jobId}` (e.g. `wt-discovery`) | `/tmp/workflow-wt-discovery` |
| Progress-update | `wt-{jobId}` | `/tmp/workflow-wt-progress-update` |

**Critical**: Ticket pipeline jobs share a single worktree per ticket across all stages. If ticket T-1 runs research then implement, both run in `/tmp/workflow-wt-T-1`. This preserves the working state (context files, plan files, code changes).

### Worktree ID uniqueness

Worktree IDs must be unique per concurrent job. Bug fix history shows that hardcoded IDs (e.g., `"wt-discover"`) crash when multiple instances run in parallel. Using `job.jobId` (unique per job instance) prevents this.

### Cleanup

After landing, the merge queue cleans up:
```bash
jj bookmark delete ticket/{ticketId}
jj workspace close {workspaceName}
rm -rf {worktreePath}
```

---

## 13. Cross-Run Durability

### How ticket state persists

Smithers stores all output rows in SQLite, keyed by `(run_id, node_id, iteration)`. These persist across runs.

### Finding resumable tickets

`durability.ts` reads the Smithers DB directly (bypassing ctx) to find tickets from prior runs:

```typescript
function getResumableTickets(dbPath, currentRunId): CrossRunTicketState[] {
  const allState = loadCrossRunTicketState(dbPath);
  return allState.filter(t =>
    !t.landed &&
    t.latestRunId !== currentRunId &&
    t.pipelineStage !== "not_started"
  );
}
```

`loadCrossRunTicketState` queries each stage table for `SELECT DISTINCT node_id, run_id, MAX(iteration)`, extracts ticket IDs by stripping the stage suffix, and returns the most advanced stage seen per ticket.

### Integration with scheduler

Resumable tickets are passed to `TicketScheduler` as a prop. The scheduler prompt renders a "Resumable Tickets from Previous Runs" section with instructions to prioritize them over discovering new tickets. Tickets further in the pipeline get higher priority.

### TicketResume component

An alternative resume mechanism. Renders a `<Task>` that checks if each prior ticket's jj bookmark still exists (`jj bookmark list | grep ticket/{ticketId}`). Sorted by pipeline stage (most advanced first).

---

## 14. The Monitor

### Fire-and-forget pattern

The Monitor runs as a sibling of SuperRalph in a `<Parallel>`:

```tsx
<Task id="monitor" output={monitorOutputSchema} continueOnFail={true}>
  {async () => {
    runMonitorUI({ dbPath, runId, projectName, prompt }).catch(() => {});
    return { started: true, status: "running" };  // Returns immediately
  }}
</Task>
```

`continueOnFail={true}` ensures a TUI crash doesn't block the pipeline. The polling loop is NOT awaited.

### TUI implementation

Uses `@opentui/core` and `bun:sqlite`. Three-panel layout:
- **Header**: Run ID and truncated prompt
- **Stats bar**: Discovered / In Pipeline / Landed / Evicted / Jobs counts
- **Left panel (Pipeline)**: Per-ticket kanban with stage icons (completed/running/failed/pending)
- **Right panel**: Active jobs or ticket detail on Enter

Polls both databases every 2 seconds.

---

## 15. Two-Database Architecture

### Smithers DB (`.super-ralph/workflow.db`)

Managed by Smithers via Drizzle ORM. Stores:
- All task outputs (one table per Zod schema key, e.g. `research`, `implement`, `land`)
- Internal tables: `_smithers_runs`, `_smithers_frames`, `_smithers_attempts`, `_smithers_nodes`, `_smithers_approvals`
- Each row has `run_id`, `node_id`, `iteration` columns

### Scheduled Tasks DB (`scheduled-tasks.db`)

Separate SQLite database managed by `scheduledTasks.ts`. Stores the active job queue:

```sql
CREATE TABLE scheduled_tasks (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ticket_id TEXT,
  focus_id TEXT,
  created_at_ms INTEGER NOT NULL
);
```

Functions: `insertJob` (INSERT OR IGNORE), `removeJob` (DELETE), `getActiveJobs` (SELECT ordered by creation time).

### Why two databases?

Smithers has no native job queue concept. It stores outputs but doesn't track "what should run next." The scheduled-tasks DB fills this gap: it's a lightweight queue that the scheduler writes to and SuperRalph reads from on each iteration.

---

## 16. Agent Configuration

### Agent construction

Five role-based agents are created in the generated workflow:

| Role | Primary Preference | Model |
|------|-------------------|-------|
| `planning` | claude | claude-sonnet-4-6 |
| `implementation` | codex | gpt-5.3-codex |
| `testing` | codex | gpt-5.3-codex |
| `reviewing` | claude | claude-sonnet-4-6 |
| `reporting` | claude | claude-sonnet-4-6 |

Agent selection via `choose()`:
```typescript
function choose(primary: "claude" | "codex", systemPrompt: string) {
  if (primary === "claude" && HAS_CLAUDE) return createClaude(systemPrompt);
  if (primary === "codex" && HAS_CODEX) return createCodex(systemPrompt);
  if (HAS_CLAUDE) return createClaude(systemPrompt);
  return createCodex(systemPrompt);
}
```

ClaudeCodeAgent: `dangerouslySkipPermissions: true`, 60-minute timeout.
CodexAgent: `yolo: true`.

### Agent pool and resolution

Agents are passed to SuperRalph as a `Record<string, { agent, description }>` pool. The scheduler assigns `agentId` strings to jobs. `resolveAgent` looks up the agent in the pool:

```typescript
function resolveAgent(pool, agentId): AgentLike {
  if (agentId && pool[agentId]) return pool[agentId].agent;
  return Object.values(pool)[0]?.agent;  // fallback to first
}
```

---

## 17. Configuration Flow

```
CLI args
  → promptText (inline, file, or stdin)
  → clarificationSession (interactive TUI)
  → buildFallbackConfig (auto-detected from repo)
      ↓
  InterpretConfig Task (AI agent)
  Inputs: prompt, clarificationSession, fallbackConfig, packageScripts, detectedAgents
  Output: interpretConfigOutputSchema
      ↓
  SuperRalph receives config via {...getInterpretedConfig(ctx)}
  Config fields: projectName, projectId, focuses, specsPath, referenceFiles,
                 buildCmds, testCmds, preLandChecks, postLandChecks,
                 codeStyle, reviewChecklist, maxConcurrency
```

### InterpretConfig output schema

```typescript
z.object({
  projectName: z.string().min(1),
  projectId: z.string().min(1),
  focuses: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(),
  })).min(1).max(12),
  specsPath: z.string().min(1),
  referenceFiles: z.array(z.string()),
  buildCmds: z.record(z.string(), z.string()),
  testCmds: z.record(z.string(), z.string()),
  preLandChecks: z.array(z.string()),
  postLandChecks: z.array(z.string()),
  codeStyle: z.string().min(1),
  reviewChecklist: z.array(z.string()).min(1),
  maxConcurrency: z.number().int().min(1).max(64),
  reasoning: z.string().optional(),
})
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Used for question generation API call |
| `WORKFLOW_MAX_CONCURRENCY` | 6 | Default max parallel agents (capped 1-32) |
| `USE_CLI_AGENTS` | Set to "1" by CLI | Tells Smithers to use CLI agents |
| `SMITHERS_DEBUG` | Set to "1" by CLI | Enables debug output |

### Run ID format

```
sr-{base36-timestamp}-{8-char-uuid}
```

Example: `sr-m3abc12-deadbeef`

---

## Appendix: End-to-End Ticket Lifecycle

```
[Iteration 0]
  ├─ No tickets exist
  ├─ Scheduler: "pipeline starved, schedule discovery"
  │     → insertJob(db, {jobId:"discovery", jobType:"discovery"})
  │
[Iteration 1]
  ├─ Job("discovery") runs in Worktree("wt-discovery")
  │     Agent reads specs, codebase → outputs discover:{tickets:[T-1(medium), T-2(trivial)]}
  ├─ isJobComplete(discovery) = true → removeJob
  │
[Iteration 2]
  ├─ selectDiscoverTickets → [T-1, T-2]
  ├─ Scheduler: "schedule T-1:research + T-2:implement"
  │     → insertJob(db, {T-1:research}), insertJob(db, {T-2:implement})
  │
[Iterations 3-N: Pipeline execution (parallel)]
  │
  │  T-2 (trivial: implement → build-verify)
  │  ├─ T-2:implement runs → outputs implement:{filesCreated, filesModified, whatWasDone}
  │  ├─ T-2:build-verify runs → outputs build_verify:{buildPassed: true}
  │  └─ isTicketTierComplete(T-2, "trivial") = true ← final stage is build-verify ✓
  │
  │  T-1 (medium: research → plan → implement → test → build-verify → code-review)
  │  ├─ T-1:research → {contextFilePath: "docs/context/T-1.md", summary: "..."}
  │  ├─ T-1:plan → reads research → {planFilePath: "docs/plans/T-1.md", implementationSteps: [...]}
  │  ├─ T-1:implement → reads plan, evictionContext → {whatWasDone, filesCreated, filesModified}
  │  ├─ T-1:test → runs test suites → {testsPassed, failingSummary}
  │  ├─ T-1:build-verify → {buildPassed: true}
  │  └─ T-1:code-review → {severity: "minor", feedback: "...", issues: [...]}
  │     isTicketTierComplete(T-1, "medium") = true ← final stage is code-review ✓
  │
[When tierComplete && !landed]
  └─ AgenticMergeQueue fires with [T-2, T-1]
       │
       ├─ T-2: rebase onto main → CI passes → fast-forward main → push → cleanup
       │     → merge_queue_result:{ticketsLanded:[{T-2, mergeCommit: "abc123"}]}
       │     → selectLand(T-2).merged = true
       │     → T-2 moves to completedTicketIds
       │
       ├─ T-1: rebase onto main → CONFLICT → evict with context
       │     → merge_queue_result:{ticketsEvicted:[{T-1, reason: "rebase_conflict", details: "..."}]}
       │     → selectLand(T-1).evicted = true, tierComplete = false
       │
[Next iterations: Eviction recovery]
  ├─ Scheduler re-schedules T-1:implement (or earlier stage as needed)
  ├─ Agent receives evictionContext with:
  │     - Eviction reason
  │     - Attempted commit log
  │     - Diff summary of what was attempted
  │     - What landed on main since the ticket branched
  ├─ Agent re-implements with awareness of the conflict
  ├─ Pipeline stages re-run (test, build-verify, code-review)
  ├─ tierComplete = true again → re-enters merge queue
  └─ Second landing attempt succeeds → T-1 landed
```

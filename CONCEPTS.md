# Concepts

Common infrastructure shared by all Super-Ralph-Lite workflows.

---

## Table of Contents

1. [What Is Super-Ralph-Lite](#1-what-is-super-ralph-lite)
2. [The Smithers Engine](#2-the-smithers-engine)
3. [Agent System](#3-agent-system)
4. [jj (Jujutsu) VCS Integration](#4-jj-jujutsu-vcs-integration)
5. [Worktree Isolation](#5-worktree-isolation)
6. [Complexity Tiers](#6-complexity-tiers)
7. [Quality Pipeline Stages](#7-quality-pipeline-stages)
8. [The Merge Queue](#8-the-merge-queue)
9. [Two-Database Architecture](#9-two-database-architecture)
10. [CLI Architecture](#10-cli-architecture)

---

## 1. What Is Super-Ralph-Lite

Super-Ralph-Lite is a multi-agent AI development pipeline built on the Smithers workflow engine. It takes a description of work to be done on a codebase and runs it through a configurable pipeline of AI agents (research, plan, implement, test, review, land).

Two workflow modes exist:

| Mode | Input | Scheduling | See |
|------|-------|-----------|-----|
| **Super-Ralph** | Free-form prompt | AI-driven (dynamic discovery + scheduler) | [SUPER_RALPH.md](SUPER_RALPH.md) |
| **Scheduled Work** | RFC/PRD document | Deterministic DAG (pre-planned) | [RALPHINHO.md](RALPHINHO.md) |

Both modes share the same core infrastructure documented here: the Smithers engine, agent system, jj VCS, worktree isolation, complexity tiers, quality pipeline stages, and merge queue.

### Key Technologies

| Layer | Technology |
|-------|-----------|
| Workflow engine | Smithers (JSX-based, React reconciler) |
| Runtime | Bun >= 1.3 |
| Database | SQLite (Drizzle ORM for Smithers, raw bun:sqlite for job queues) |
| Schema validation | Zod |
| VCS | jj (Jujutsu) exclusively, no git fallback |
| Prompt templates | MDX (SuperRalph), template literals (ScheduledWork) |
| Agents | ClaudeCodeAgent (claude-sonnet-4-6 / claude-opus-4-6), CodexAgent (gpt-5.3-codex) |

---

## 2. The Smithers Engine

Smithers is a JSX-based workflow engine with a React-like reconciler. Workflows are defined as JSX component trees. Smithers renders the tree, schedules runnable tasks, executes them, persists outputs to SQLite, and re-renders.

### Core Primitives

| Primitive | Purpose |
|-----------|---------|
| `<Workflow>` | Top-level wrapper. Defines name and caching behavior. |
| `<Ralph>` | Iterating loop. Re-renders its children until `until` is true or no more work exists. |
| `<Sequence>` | Runs children one after another. Child N+1 starts only after child N finishes. |
| `<Parallel>` | Runs children concurrently, up to `maxConcurrency`. |
| `<Task>` | Sends a prompt to an agent, captures structured output against a Zod schema. |
| `<Worktree>` | Creates an isolated jj workspace at a path. Sets `cwd` for child tasks. |

### The Render-Schedule-Execute Loop

Each Ralph iteration follows this cycle:

1. **Render**: The builder function runs. Components read current state from `ctx` and return JSX describing what tasks should exist.
2. **Schedule**: Smithers evaluates which `<Task>` nodes are runnable (pending + under concurrency limit).
3. **Execute**: Runnable tasks execute (agent prompts sent, compute functions called).
4. **Persist**: Outputs are validated against Zod schemas and written to SQLite.
5. **Re-render**: The builder runs again with updated context. New tasks may appear or disappear.

A new Ralph iteration starts when ALL tasks within the current iteration reach a terminal state (finished, failed, skipped, or cancelled).

### Context API

Every workflow receives a `SmithersCtx` object:

```typescript
ctx.latest(schemaKey, nodeId)   // Read the most recent output for a (schema, nodeId) pair
ctx.outputs(schemaKey, nodeId)  // Read all output rows for a (schema, nodeId) pair
ctx.outputMaybe(schemaKey, nodeId) // Like latest(), but returns undefined instead of throwing
ctx.runId                       // Current run identifier
```

All outputs are keyed by `(run_id, node_id, iteration)` in SQLite. This allows reading results from prior iterations and, in SuperRalph's case, from prior runs.

### Output Schemas

Each workflow registers its output schemas with `createSmithers()`:

```typescript
const { smithers, outputs, Workflow } = createSmithers({
  outputs: { research: z.object({...}), plan: z.object({...}), ... }
});
```

Each schema key becomes a SQLite table. Tasks reference schemas via `output={outputs.research}`.

---

## 3. Agent System

### Agent Types

Two agent implementations exist:

| Agent | CLI Tool | Key Config |
|-------|---------|------------|
| `ClaudeCodeAgent` | `claude` | `dangerouslySkipPermissions: true`, 60-min timeout |
| `CodexAgent` | `codex` | `yolo: true` |

Both are CLI wrappers -- Smithers spawns the agent CLI as a subprocess with a prompt and structured output schema.

### Agent Selection

Both workflows detect available agents at init time (`detectAgents()` checks `which claude`, `which codex`, `which gh`). The selection logic follows a preference-with-fallback pattern:

```typescript
// SuperRalph: choose(primary, systemPrompt)
function choose(primary: "claude" | "codex", systemPrompt: string) {
  if (primary === "claude" && HAS_CLAUDE) return createClaude(systemPrompt);
  if (primary === "codex" && HAS_CODEX)   return createCodex(systemPrompt);
  if (HAS_CLAUDE) return createClaude(systemPrompt);
  return createCodex(systemPrompt);
}

// ScheduledWork: chooseAgent(primary, role) -- also supports "opus" tier
function chooseAgent(primary: "claude" | "codex" | "opus", role: string) { ... }
```

If neither agent is found, the CLI throws immediately.

### Role-Based Agent Pools

Each workflow defines multiple agents with distinct roles. The number and assignment differ by workflow (see workflow-specific docs), but the concept is the same: each pipeline stage is assigned an agent suited for its task type (e.g., Codex for implementation, Claude Opus for reviews).

---

## 4. jj (Jujutsu) VCS Integration

The entire VCS layer uses jj exclusively. No git fallback. Both workflows enforce jj availability at init time via `ensureJjAvailable()`.

### Why jj

jj provides first-class workspace support (isolated working copies of the same repo), atomic commits without staging, and a functional approach to version control that fits the multi-agent model well.

### Colocated Mode

The project assumes jj colocated mode (`jj git init --colocate`). `jj git push` and `jj git fetch` bridge to the remote git repository.

### Bookmark Convention

Each work unit (ticket or unit) gets a bookmark:

| Workflow | Pattern | Example |
|----------|---------|---------|
| SuperRalph | `ticket/{ticketId}` | `ticket/T-1` |
| ScheduledWork | `unit/{unitId}` | `unit/metadata-cleanup` |

### Common jj Commands

**Agent commits** (all pipeline stages that write code):
```bash
jj describe -m "scope: message"
jj new
jj bookmark set ticket/{id} -r @    # or unit/{id}
jj git push --bookmark ticket/{id}
```

**Merge queue landing**:
```bash
jj git fetch
jj rebase -b bookmark("ticket/{id}") -d main
# run CI checks
jj bookmark set main -r bookmark("ticket/{id}")  # fast-forward
jj git push --bookmark main
jj bookmark delete ticket/{id}
```

**Eviction context collection**:
```bash
jj log -r main..bookmark("ticket/{id}") --reversed        # attempted commits
jj diff -r roots(main..bookmark("ticket/{id}")) --summary  # attempted changes
jj log -r bookmark("ticket/{id}")..main --reversed          # what landed since branch
```

---

## 5. Worktree Isolation

Every job runs inside an isolated jj workspace. This ensures agents don't interfere with each other's working copies.

### How Worktrees Are Created

Both workflows use the Smithers `<Worktree>` component:

```tsx
<Worktree id={`wt-${id}`} path={`/tmp/workflow-wt-${id}`} branch={`unit/${id}`}>
  <Task .../>
</Worktree>
```

Smithers creates a `jj workspace add` at the given path. The `cwd` for the agent's `<Task>` is set to the worktree path.

### Path Convention

| Scope | Worktree Path |
|-------|---------------|
| Per-ticket/unit pipeline stages | `/tmp/workflow-wt-{id}` |
| Discovery jobs (SuperRalph) | `/tmp/workflow-wt-discovery` |
| Progress updates (SuperRalph) | `/tmp/workflow-wt-progress-update` |

**Critical**: Pipeline stages for the same work unit share a single worktree. If unit X runs research then implement, both run in `/tmp/workflow-wt-X`. This preserves working state (context files, plan files, code changes) across stages.

### Cleanup

After landing, the merge queue cleans up:
```bash
jj bookmark delete ticket/{id}    # or unit/{id}
jj workspace close {workspaceName}
rm -rf {worktreePath}
```

---

## 6. Complexity Tiers

Every work unit is assigned a complexity tier that determines which quality pipeline stages it goes through. Both workflows use the same four tier names with different stage compositions:

| Tier | Description |
|------|-------------|
| `trivial` | Single-file change, no tests needed (SuperRalph) or basic test only (ScheduledWork) |
| `small` | Few files, needs tests + basic review |
| `medium` | Multi-file, full pipeline with research/plan/review |
| `large` | Complex, full pipeline with all quality gates |

See each workflow's documentation for the exact stage lists per tier.

### Tier Assignment

- **SuperRalph**: Tiers are assigned by the AI during ticket discovery. The Discover prompt instructs the agent to default to the smallest appropriate tier.
- **ScheduledWork**: Tiers are assigned by the AI during RFC decomposition. The decompose system prompt defines tier criteria.

### Tier Enforcement

In both workflows, tier enforcement is **prompt-level only**. The scheduler (SuperRalph) or rendered workflow (ScheduledWork) respects tier definitions, but no hard runtime check prevents a stage from running outside its tier.

---

## 7. Quality Pipeline Stages

Both workflows share the same conceptual pipeline, though the exact stages and their prompt implementations differ. Here is the common model:

```
[Research] → [Plan] → [Implement] → [Test] → [Review] → [Review Fix] → [Land]
```

### Stage Descriptions

| Stage | Purpose | Produces |
|-------|---------|----------|
| **Research** | Gather context from codebase, specs, reference materials | Context document (committed to repo) |
| **Plan** | Design implementation approach with atomic steps | Plan document (committed to repo) |
| **Implement** | Write code following the plan, using TDD where applicable | Code changes (committed and pushed) |
| **Test** | Run test suites, fix failures | Pass/fail report |
| **Build Verify** | Run builds, fix compilation errors (SuperRalph only) | Build status |
| **Spec/PRD Review** | Check implementation against specifications | Severity + issues list |
| **Code Review** | Check code quality (security, style, coverage, architecture) | Severity + issues list |
| **Review Fix** | Address issues raised by reviews | Resolution summary |
| **Report/Final Review** | Final quality gate and completion assessment | Status determination |

### TDD Philosophy

Both workflows instruct agents to follow TDD where applicable:
1. Write failing tests first
2. Write minimal implementation to make tests pass
3. Refactor
4. The implement prompt includes logic to assess whether TDD applies (behavior changes → TDD, mechanical changes → direct implementation)

### Feedback Loops

When a stage fails or reviews find issues, context flows back to earlier stages on the next iteration:
- **Review issues** → fed into ReviewFix prompt
- **Test failures** → fed into Implement prompt on re-run
- **Merge eviction** → fed into Implement (or Research/Plan) prompt as eviction context

---

## 8. The Merge Queue

Both workflows use an agent-driven merge queue to land completed work onto main. The concept is the same; implementations differ.

### Landing Flow

For each tier-complete work unit, in priority order:

1. Switch to the unit's worktree
2. Rebase onto main: `jj rebase -b bookmark("unit/{id}") -d main`
3. Run CI checks (build + tests) in the rebased state
4. If checks pass: fast-forward main (`jj bookmark set main -r bookmark("unit/{id}")`), push, mark as LANDED
5. If checks fail or conflicts occur: mark as EVICTED with full context

### Eviction and Recovery

When a unit is evicted:
- The merge queue captures: eviction reason, attempted commit log, diff summary, what landed on main since the branch point
- This **eviction context** is injected into the implement prompt (and sometimes research/plan) on the next pipeline pass
- The agent re-implements with awareness of the conflict, avoiding the problematic files/lines

### Conflict Resolution Policy

- **Trivially resolvable** conflicts (lockfiles, generated code) may be resolved inline by the merge queue agent
- **Complex conflicts** or CI failures cause eviction with full context for the next pipeline pass

---

## 9. Two-Database Architecture

### Smithers DB (`.ralphinho/workflow.db` or `.super-ralph/workflow.db`)

Managed by Smithers via Drizzle ORM. Stores:
- All task outputs (one table per Zod schema key)
- Internal tables: `_smithers_runs`, `_smithers_frames`, `_smithers_attempts`, `_smithers_nodes`, `_smithers_approvals`
- Each row has `run_id`, `node_id`, `iteration` columns

### Scheduled Tasks DB (`scheduled-tasks.db`) — SuperRalph Only

A separate SQLite database for tracking the active job queue. Exists because Smithers has no native job queue concept:

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

ScheduledWork does not need this database because its execution order is deterministic (DAG-driven, not scheduler-driven).

---

## 10. CLI Architecture

### Entry Point

`ralphinho` is the unified CLI (`src/cli/ralphinho.ts`), registered as the package bin.

```
ralphinho init super-ralph "prompt"       # Initialize intent-driven workflow
ralphinho init scheduled-work ./rfc.md    # Initialize RFC-driven workflow
ralphinho plan                            # (Re)generate work plan (scheduled-work only)
ralphinho run                             # Execute the initialized workflow
ralphinho run --resume <run-id>           # Resume a previous run
ralphinho monitor                         # Attach TUI to running workflow
ralphinho status                          # Show current state
```

### Shared Utilities (`src/cli/shared.ts`)

| Function | Purpose |
|----------|---------|
| `parseArgs()` | CLI argument parsing |
| `readPromptInput()` | Read prompt from file/string/stdin |
| `scanRepo()` | Detect project name, package manager, build/test commands |
| `detectAgents()` | Check for claude, codex, gh on PATH |
| `ensureJjAvailable()` | Verify jj is installed |
| `buildFallbackConfig()` | Generate default config from repo analysis |
| `findSmithersCliPath()` | Locate the Smithers CLI binary |
| `launchSmithers()` | Spawn the Smithers process with the generated workflow |

### Workflow Generation

Both workflows follow the same pattern:
1. **Init**: Gather inputs (prompt/RFC), scan repo, detect agents, run AI pre-processing
2. **Generate**: Emit a complete `.tsx` workflow file with all constants baked in as JS literals
3. **Launch**: Spawn Smithers with the generated workflow file

The generated workflow imports Smithers primitives and the workflow's own schemas, then composes a JSX tree of `<Workflow>`, `<Ralph>`, `<Sequence>`, `<Parallel>`, `<Task>`, and `<Worktree>` nodes.

### Run ID Format

```
sr-{base36-timestamp}-{8-char-uuid}
```

Example: `sr-m3abc12-deadbeef`

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Used for pre-workflow AI calls (questions, decomposition) |
| `WORKFLOW_MAX_CONCURRENCY` | 6 | Default max parallel agents (capped 1-32) |
| `USE_CLI_AGENTS` | Set to "1" by CLI | Tells Smithers to use CLI agents |
| `SMITHERS_DEBUG` | Set to "1" by CLI | Enables debug output |

### Project Directory

Both workflows store state in `.ralphinho/`:
- `.ralphinho/config.json` — Mode, repoRoot, agents, settings
- `.ralphinho/work-plan.json` — Work plan (ScheduledWork only)
- `.ralphinho/generated/workflow.tsx` — Generated Smithers workflow
- `.ralphinho/workflow.db` — Smithers SQLite database

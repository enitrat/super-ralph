# Ralphinho

An RFC-driven, multi-agent development pipeline. Takes an RFC document, decomposes it into work units with a dependency DAG, runs each unit through a quality pipeline of specialized AI agents, and lands them onto main via a merge queue.

For infrastructure details (Smithers engine, jj VCS, agent system), see [CONCEPTS.md](CONCEPTS.md).

---

## 1. Overview

### Setup

```
                   ┌─────────────┐
                   │  RFC / PRD  │
                   └──────┬──────┘
                          │
           ┌──────────────▼──────────────┐
           │  ralphinho init scheduled   │
           │                             │
           │  1. Scan repo (build/test   │
           │     commands, pkg manager)  │
           │  2. Detect agents on PATH   │
           │  3. AI decomposes RFC into  │
           │     work units + DAG        │
           └──────────────┬──────────────┘
                          │
                ┌─────────▼─────────┐
                │  work-plan.json   │
                │                   │
                │  units:           │
                │   ├─ id, tier     │
                │   ├─ description  │
                │   ├─ acceptance   │
                │   └─ deps: [...]  │
                └─────────┬─────────┘
                          │
                   human reviews
                    and edits
                          │
                ┌─────────▼─────────┐
                │  ralphinho run    │
                │                   │
                │  Generates a      │
                │  Smithers .tsx    │
                │  workflow from    │
                │  the work plan    │
                └───────────────────┘
```

### Main Loop

The DAG determines execution order. Units with no dependencies form layer 0; units whose deps are all in prior layers form layer N. Layers run sequentially. Units within a layer run in parallel, each in its own jj worktree.

```
┌─ Ralph Loop (up to MAX_PASSES=3) ─────────────────────────────────┐
│                                                                    │
│  For each DAG layer (sequential):                                  │
│                                                                    │
│  ┌─ Phase 1: Quality Pipelines (parallel, per unit) ────────────┐ │
│  │                                                               │ │
│  │  ┌── Unit A (large) ──┐   ┌── Unit B (small) ──┐            │ │
│  │  │                     │   │                     │            │ │
│  │  │  Research            │   │  Implement          │            │ │
│  │  │  Plan                │   │  Test               │            │ │
│  │  │  Implement           │   │  Code Review        │            │ │
│  │  │  Test                │   │                     │            │ │
│  │  │  PRD + Code Review   │   └─────────────────────┘            │ │
│  │  │  Review Fix          │                                     │ │
│  │  │  Final Review        │                                     │ │
│  │  │                     │                                      │ │
│  │  └─────────────────────┘                                      │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌─ Phase 2: Merge Queue ──────────────────────────────────────┐  │
│  │  For each tier-complete unit:                                │  │
│  │    rebase onto main → run tests → land or evict             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Evicted units re-enter with conflict context on next pass         │
└────────────────────────────────────────────────────────────────────┘
```

### Per-Unit Quality Pipeline (detailed)

Each unit runs through the stages below inside its own worktree. Stages are gated by tier — a `small` unit skips research, plan, PRD review, review-fix, and final review. The diagram shows the full `large` pipeline with all feedback loops.

```
                          ╔═══════════════════════════════════════════════╗
                          ║  EVICTION / REVIEW FEEDBACK (from prior pass) ║
                          ║  Injected into research/plan/implement when   ║
                          ║  a previous attempt failed or was evicted.    ║
                          ╚═══════════════════════╤═══════════════════════╝
                                                  │
         ┌────────────────────────────────────────┼──────────────────────┐
         │  Per-Unit Pipeline (in worktree)       │                      │
         │                                        ▼                      │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  RESEARCH                                       [Sonnet] │ │
         │  │  Read RFC sections + codebase. Produce a context doc     │ │
         │  │  with findings, file references, and open questions.     │ │
         │  │  ── medium & large only ──                               │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                            ▼                                  │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  PLAN                                             [Opus] │ │
         │  │  Read context doc + RFC. Design atomic implementation    │ │
         │  │  steps, identify files to create/modify, plan tests.     │ │
         │  │  ── medium & large only ──                               │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                            ▼                                  │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  IMPLEMENT                                      [Codex] │ │
         │  │  Write code following the plan. TDD for new behavior,    │ │
         │  │  direct implementation for mechanical changes. Receives  │ │
         │  │  dependency context (what prior units built) + eviction  │ │
         │  │  context + review feedback from prior passes.            │ │
         │  │  ── all tiers ──                                         │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                            ▼                                  │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  TEST                                            [Sonnet] │ │
         │  │  Run build + full test suite. Report pass/fail counts.   │ │
         │  │  Fix compilation errors if possible.                     │ │
         │  │  ── all tiers ──                                         │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                  ┌─────────┴─────────┐                        │
         │                  │  run in parallel   │                        │
         │                  ▼                   ▼                        │
         │  ┌─────────────────────┐ ┌─────────────────────────┐         │
         │  │  PRD REVIEW [Sonnet]│ │  CODE REVIEW      [Opus]│         │
         │  │                     │ │                          │         │
         │  │  Does the code      │ │  Is the code well-      │         │
         │  │  match the RFC spec │ │  written? Check error    │         │
         │  │  and acceptance     │ │  handling, security,     │         │
         │  │  criteria?          │ │  conventions, coverage.  │         │
         │  │                     │ │                          │         │
         │  │  ── med & large ──  │ │  ── small/med/large ──  │         │
         │  └─────────┬───────────┘ └──────────┬──────────────┘         │
         │            └──────────┬─────────────┘                         │
         │                       │                                       │
         │            both approved? ───yes───▶ (skip review-fix)        │
         │                       │ no                     │              │
         │                       ▼                        │              │
         │  ┌──────────────────────────────────────────┐  │              │
         │  │  REVIEW FIX                      [Codex] │  │              │
         │  │  Address issues in severity order         │  │              │
         │  │  (critical first). Fix valid issues,     │  │              │
         │  │  document false positives. Re-run         │  │              │
         │  │  build + tests after each fix.            │  │              │
         │  │  ── medium & large only ──                │  │              │
         │  └─────────────────────┬────────────────────┘  │              │
         │                        │◄──────────────────────┘              │
         │                        ▼                                      │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  FINAL REVIEW                                     [Opus] │ │
         │  │  Quality gate. Checks: all acceptance criteria met,      │ │
         │  │  tests pass, review severity ≤ minor. Decides            │ │
         │  │  readyToMoveOn. If false, reasoning is fed back to       │ │
         │  │  implement on the next Ralph pass.                       │ │
         │  │  ── large only ──                                        │ │
         │  └─────────────────────┬────────────────────────────────────┘ │
         │                        │                                      │
         │                        ▼                                      │
         │              ┌─────────────────┐                              │
         │              │  TIER COMPLETE  │──────▶ enters merge queue    │
         │              └─────────────────┘                              │
         └───────────────────────────────────────────────────────────────┘

Feedback loops:
  ─ Final review reasoning  ──────────────────────┐
  ─ PRD review feedback     ──────────────────────┤
  ─ Code review feedback    ──────────────────────┼──▶ injected into IMPLEMENT
  ─ Failing test output     ──────────────────────┤     on next Ralph pass
  ─ Merge queue eviction ctx ─────────────────────┘
```

### Landing on Main

```
 unit/{id} branch
        │
        ▼
┌──────────────────┐    conflict    ┌────────────────────────┐
│  Rebase onto     │──────────────▶│  EVICT                 │
│  main            │                │  (capture conflict ctx) │
└───────┬──────────┘                └────────────────────────┘
        │ clean
        ▼
┌──────────────────┐    fail        ┌────────────────────────┐
│  Run build +     │──────────────▶│  EVICT                 │
│  tests           │                │  (capture test output)  │
└───────┬──────────┘                └────────────────────────┘
        │ pass
        ▼
┌──────────────────┐
│  Fast-forward    │
│  main to unit    │
│  tip, push,      │
│  delete bookmark │
└──────────────────┘
```

---

## 2. Detailed Design

### A. Pre-Workflow: RFC Decomposition

**What happens**: `ralphinho init scheduled-work ./rfc.md` scans the repo, detects available agents, and sends the RFC to an AI (Claude Sonnet) that decomposes it into work units with a dependency DAG. The output is `.ralphinho/work-plan.json`.

**Why an upfront decomposition**: The alternative — discovering work at runtime — makes the pipeline unpredictable. Upfront decomposition gives the human a concrete plan to review and edit before any agent touches code. It also makes execution deterministic: the DAG locks in parallelism and ordering, so reruns are reproducible.

**Why human review matters**: The AI decomposition is a first draft. Humans can adjust tiers (promote/demote complexity), merge units that overlap on files (avoiding merge conflicts), remove unnecessary units, or tighten acceptance criteria. This is the single highest-leverage intervention point in the pipeline.

**Decomposition rules the AI follows**:
- **Prefer fewer, cohesive units** — each unit adds pipeline overhead and merge risk. Only split when units touch genuinely independent files.
- **Minimize cross-unit file overlap** — two units modifying the same file will conflict at merge time, requiring an expensive re-run.
- **Keep tests with implementation** — never decompose "implement X" and "test X" as separate units. Tests are part of the implementation.
- **Tiers are conservative** — `trivial` for single-file mechanical changes, `large` for cross-cutting architectural work.

**The DAG**: Dependencies are only added where a real code dependency exists (unit B imports a type that unit A creates). The DAG is validated for missing references and cycles. `computeLayers()` groups units into topological layers for execution.

### B. Quality Pipeline: Separate Context Windows

Each work unit runs through a quality pipeline whose depth depends on its tier:

| Tier | Pipeline |
|------|----------|
| `trivial` | implement → test |
| `small` | implement → test → code-review |
| `medium` | research → plan → implement → test → prd-review + code-review → review-fix |
| `large` | research → plan → implement → test → prd-review + code-review → review-fix → final-review |

**The core principle is separate context windows for separate concerns.**

Each stage runs in its own agent process with its own context window. The researcher reads the codebase and RFC to produce a context document. The planner reads that document to produce a plan. The implementer reads the plan to write code. The reviewer reads the code to find issues. No single agent has to hold the entire problem in context.

This separation is deliberate:
- **Research and planning** use Claude (Sonnet/Opus) — good at reading code, understanding architecture, and producing structured analysis.
- **Implementation** uses Codex — good at writing code, running commands, and iterating on test failures.
- **Reviews** use Claude (Opus for code review, Sonnet for PRD review) — good at spotting issues without being the author of the code.

The reviewer never wrote the code it's reviewing. This eliminates author bias — the same failure mode that makes self-review unreliable in human teams.

**Why code review is an explicit stage**: The code review stage enforces quality standards that the implementer might skip under pressure to "just make the tests pass": error handling, security, naming conventions, test coverage. It runs on Claude Opus specifically because code review requires nuanced judgment. Reviews produce structured output with severity levels (`none`, `minor`, `major`, `critical`), and issues above `minor` trigger the review-fix stage.

**How cross-stage data flows**: Each stage reads structured output from previous stages via Smithers' context API. The implement stage also receives dependency context — for units with deps, it gets the `whatWasDone`, `filesCreated`, and `filesModified` from all completed dependency implementations. This tells the implementer what APIs and files its dependencies produced without needing to rediscover them.

**Feedback loops**: When reviews find issues, the review-fix agent addresses them in severity order. If the final review (large tier only) decides the unit isn't ready (`readyToMoveOn: false`), its `reasoning` is fed back to the implementer on the next Ralph pass, along with any PRD review and code review feedback.

---

## 3. Merge Queue

After all quality pipelines in a DAG layer complete, a merge queue task lands tier-complete units onto main. The merge queue is a single agent (Claude Opus) that processes all ready units for the layer.

**Why an agent-driven merge queue**: Rebasing, conflict resolution, and test verification require judgment calls — is this conflict trivially resolvable (a lockfile regeneration) or does it need a full re-implementation? An agent can make that call. A script cannot.

**How it works**:

1. For each tier-complete unit, the agent switches to its worktree and rebases onto current main: `jj rebase -b bookmark("unit/{id}") -d main`
2. If the rebase has **conflicts**: capture the full conflict context (which files, what changed on main since the branch point) and mark the unit as **evicted**. Do not attempt resolution of non-trivial conflicts.
3. If the rebase is **clean**: run the full test suite in the rebased state.
   - Tests fail → **evict** with the test output
   - Tests pass → fast-forward main to the unit tip (`jj bookmark set main -r bookmark("unit/{id}")`), push, mark as **landed**
4. Clean up landed units: delete the bookmark, close the workspace.

**File overlap intelligence**: The merge queue prompt includes an analysis of which ready units touch the same files. When overlaps exist, non-overlapping units land first (no conflict risk). Overlapping units land one-by-one, rebasing each onto the updated main before attempting the next.

**Push failure handling**: If `jj git push` fails (e.g., remote updated by another process), the agent fetches, re-rebases, and retries up to 3 times before evicting.

---

## 4. Eviction & Recovery

When a unit is evicted from the merge queue, it doesn't die — it re-enters the pipeline on the next Ralph pass with full context about what went wrong.

**What gets captured on eviction**:
- The reason (conflict or test failure)
- Detailed context: conflicting files, the diff that conflicted, what landed on main since the branch point, or the full failing test output

**How it feeds back**: On the next Ralph iteration, the eviction context is injected into the implement prompt (and research/plan prompts if the tier includes those stages):

```
## MERGE CONFLICT — RESOLVE BEFORE NEXT LANDING

Your previous implementation conflicted with another unit that landed first.
Restructure your changes to avoid the conflicting files/lines described below.

{full eviction context}
```

The implementer sees exactly what conflicted and what changed on main, so it can restructure its approach rather than blindly retry.

**The Ralph loop**: The outer `<Ralph>` component re-renders until all units are landed or `MAX_PASSES` (default: 3) is exhausted. On each iteration:
- Already-landed units are skipped (they return `null` in the parallel map)
- Evicted units re-enter the full quality pipeline with their eviction context
- A pass tracker increments the pass counter

**Why MAX_PASSES = 3**: Each pass is expensive (full pipeline re-run per evicted unit). Three passes handles the common case (unit A lands, unit B conflicts, unit B re-runs and lands on pass 2) while bounding cost for pathological cases. If a unit is still not landed after 3 passes, the completion report flags it with its last failure reason and suggested next steps.

**Completion report**: After the Ralph loop terminates, a final task summarizes: total units, units landed, units failed (with last stage reached and failure reason), passes used, and actionable next steps.

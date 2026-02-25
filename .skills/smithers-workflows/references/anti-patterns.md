# Smithers Anti-Patterns

Extracted from real bug-fix commits. Every rule below comes from an actual production bug.

---

## 1. Context API Misuse (Most Common Bug Class)

### DON'T: Use `outputMaybe` for cross-iteration lookups

```typescript
// BUG: Returns undefined in iteration > 0 when research ran in iteration 0
const research = ctx.outputMaybe("research", { nodeId: `${ticketId}:research` });
```

```typescript
// FIX: latest searches ALL iterations, returns highest
const research = ctx.latest("research", `${ticketId}:research`);
```

**Rule**: Use `ctx.latest` for any lookup of data written in a previous iteration (pipeline stage outputs, config). Use `ctx.outputMaybe` only when you specifically need output from the CURRENT iteration.

### DON'T: Pass an object to `ctx.latest` (wrong signature)

```typescript
// BUG: Silently returns undefined - latest expects a string, not object
const config = ctx.latest("interpret_config", { nodeId: "interpret-config" });
```

```typescript
// FIX: Second arg is a plain string
const config = ctx.latest("interpret_config", "interpret-config");
```

### DON'T: Call `ctx.outputMaybe` with one argument

```typescript
// BUG: TypeError - undefined is not an object (evaluating 'key.nodeId')
ctx.outputMaybe("interpret-config")
```

```typescript
// FIX: Two arguments required: (table, { nodeId })
ctx.outputMaybe("interpret_config", { nodeId: "interpret-config" })
```

### DON'T: Use `ctx.latest` for repeating global jobs

```typescript
// BUG: ctx.latest finds the iter-0 row -> returns true forever
// Discovery never re-runs after first iteration
function isJobComplete(ctx, job) {
  return !!ctx.latest(outputKey, job.jobId);
}
```

```typescript
// FIX: Repeating jobs check current iteration only
function isJobComplete(ctx, job) {
  if (job.jobType === "discovery" || job.jobType === "progress-update") {
    return !!ctx.outputMaybe(outputTable, { nodeId: job.jobId, iteration: ctx.iteration });
  }
  return !!ctx.latest(outputTable, job.jobId);  // one-shot stages use latest
}
```

---

## 2. Output Schema / Component Wiring

### DON'T: Mount a component with the wrong output schema

```tsx
// BUG: AgenticMergeQueue produces merge_queue_result shape, not land shape
// Selectors looking for per-ticket land data never find it
<AgenticMergeQueue output={outputs.land} ... />
```

```tsx
// FIX: Match the schema to what the component actually produces
<AgenticMergeQueue output={outputs.merge_queue_result} ... />
```

**Rule**: Verify the `output` prop matches the schema the component ACTUALLY produces, not the one you wish it produced.

### DON'T: Use `z.any()` for agent-facing schemas

```typescript
// BUG: No JSON Schema guidance -> agents produce malformed objects
suggestedTickets: z.array(z.any())
```

```typescript
// FIX: Explicit types guide agent output
suggestedTickets: z.array(z.object({
  id: z.string(),
  title: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
}))
```

### DON'T: Use `.optional()` in Zod schemas

```typescript
// BUG: OpenAI structured outputs rejects optional fields
file: z.string().optional()
```

```typescript
// FIX: Use nullable - field stays in `required` array, agent sends null
file: z.string().nullable()
```

---

## 3. Props Wiring

### DON'T: Forget to wire props that MDX prompts depend on

```tsx
// BUG: Discover.mdx has a deduplication guard for existingTickets
// but it's never passed -> agent re-creates tickets every run
<DiscoverPrompt
  projectName={projectName}
  completedTicketIds={completedTicketIds}
  // existingTickets is MISSING -> deduplication guard is inert
/>
```

```tsx
// FIX: Pass all context that prompt guard clauses reference
<DiscoverPrompt
  projectName={projectName}
  completedTicketIds={completedTicketIds}
  existingTickets={unfinishedTickets.map(t => ({
    id: t.id, title: t.title, pipelineStage: computeStage(ctx, t.id),
  }))}
/>
```

### DON'T: Mismatch prop names between parent and MDX

```tsx
// BUG: MDX expects props.qualityChecks (Array<{name, items[]}>)
// Parent passes different name AND shape
<CodeReviewPrompt reviewChecklist={reviewChecklist} />  // wrong name + flat string[]
```

```tsx
// FIX: Match the exact prop name and shape the MDX .map() expects
<CodeReviewPrompt qualityChecks={checks.map(item => ({ name: item, items: [] }))} />
```

### DON'T: Keep passing removed props

When removing a prop from an MDX prompt, search ALL call sites in parent components and remove the corresponding JSX attribute. TypeScript catches this if MDX props are typed; without types you get silent undefined-passing.

### DON'T: Use `process.cwd()` inside workflows

```tsx
// BUG: When workflow runs from different directory than target repo
<AgenticMergeQueue repoRoot={process.cwd()} />
```

```tsx
// FIX: Resolve at startup, embed as constant or pass via props
const REPO_ROOT = resolvedAtStartup;
<AgenticMergeQueue repoRoot={REPO_ROOT} />
```

---

## 4. Scheduler / Job Lifecycle

### DON'T: Re-insert completed jobs from stale scheduler output

```typescript
// BUG: Inserts ALL scheduler-suggested jobs, including already-completed ones
for (const job of schedulerOutput.jobs) {
  insertJob(db, job);
}
```

```typescript
// FIX: Filter with isJobComplete before inserting
for (const job of schedulerOutput.jobs) {
  if (!isJobComplete(ctx, job)) {
    insertJob(db, job);
  }
}
```

### DON'T: Use hardcoded worktree IDs for parallel jobs

```tsx
// BUG: Two simultaneous discovery jobs both use "wt-discover" -> crash
return wrapWorktree("wt-discover", <Task id={job.jobId} .../>);
```

```tsx
// FIX: Use unique job ID
return wrapWorktree(job.jobId, <Task id={job.jobId} .../>);
```

### DON'T: Run side tasks outside scheduler control

```tsx
// BUG: Discovery runs before scheduler sees current state -> race condition
{unfinishedTickets.length === 0 && <Task id="discover" .../>}
```

```tsx
// FIX: ALL tasks gated behind scheduler output
{schedulerOutput?.triggerDiscovery && <Job job={discoveryJob} .../>}
```

---

## 5. Task Execution

### DON'T: Await infinite loops inside Tasks

```tsx
// BUG: Engine waits forever, blocking sibling tasks
<Task id="monitor" output={monitorSchema}>
  {async () => {
    return await runPollingLoop();  // never resolves
  }}
</Task>
```

```tsx
// FIX: Fire-and-forget, return immediately
<Task id="monitor" output={monitorSchema} continueOnFail={true}>
  {async () => {
    runPollingLoop().catch(() => {});  // DO NOT await
    return { started: true, status: "running" };
  }}
</Task>
```

### DON'T: Pass undefined agent to Task

When `agent` is undefined/falsy, the prompt string becomes `staticPayload`. Zod then validates the prompt text against the output schema -> "expected object, received string". This error is extremely misleading since it doesn't mention the missing agent.

Always verify `resolveAgent()` returns a truthy agent before passing to `<Task>`.

---

## 6. Database Queries (Monitor / Direct DB Access)

### DON'T: Query without ORDER BY when multiple iterations exist

```sql
-- BUG: May return row from iteration 0 when iteration 3 has the real data
SELECT summary FROM research WHERE run_id = ? AND node_id = ?
```

```sql
-- FIX: Always get the latest iteration
SELECT summary FROM research WHERE run_id = ? AND node_id = ?
ORDER BY iteration DESC LIMIT 1
```

### DON'T: Use first-seen-wins for multi-iteration data

```typescript
// BUG: First row seen wins - may be from earliest iteration
for (const row of rows) {
  if (!map.has(row.id)) map.set(row.id, row);  // stale data
}
```

```typescript
// FIX: Process in order, last-write-wins
const rows = db.query(`... ORDER BY iteration ASC`).all();
for (const row of rows) {
  map.set(row.id, row);  // latest iteration overwrites earlier
}
```

---

## 7. Prompt Construction

### DON'T: Write multi-line JSX ternaries in MDX

```mdx
{props.commands && props.commands.length > 0
  ? props.commands.map(c => `- ${c}`).join('\n')
  : '- Run default commands'}
```

Keep on one line - MDX parsing is stricter than TSX.

### DON'T: Hardcode VCS commands in prompts

Match commit commands to the target repo's VCS (git vs jj). Don't hardcode `git commit` in a jj-native workflow.

---

## Quick Reference Table

| Anti-Pattern | Consequence | Fix |
|---|---|---|
| `ctx.outputMaybe` for cross-iteration data | Returns undefined after iter 0 | Use `ctx.latest` |
| Object arg to `ctx.latest` | Silently returns undefined | Pass string nodeId |
| `ctx.latest` for repeating jobs | Job never re-runs | Use `ctx.outputMaybe` with explicit iteration |
| Wrong `output` schema on Task | Selectors find nothing | Verify component produces that schema |
| `z.any()` in schemas | Agents produce malformed output | Use explicit types |
| `.optional()` in schemas | OpenAI rejects it | Use `.nullable()` |
| Missing props for MDX guards | Guards are inert | Wire all referenced props |
| `process.cwd()` in workflow | Wrong directory at runtime | Resolve at startup |
| Hardcoded worktree IDs | Parallel jobs crash | Use unique job ID |
| Awaiting infinite loop in Task | Engine blocks forever | Fire-and-forget pattern |
| Undefined agent on Task | "expected object, received string" | Verify agent is truthy |
| DB query without ORDER BY | Stale iteration data | `ORDER BY iteration DESC LIMIT 1` |

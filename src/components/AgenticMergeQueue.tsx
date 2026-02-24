import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { z } from "zod";

export const mergeQueueResultSchema = z.object({
  ticketsLanded: z.array(z.object({
    ticketId: z.string(),
    mergeCommit: z.string().nullable(),
    summary: z.string(),
  })),
  ticketsEvicted: z.array(z.object({
    ticketId: z.string(),
    reason: z.string(),
    details: z.string(),
  })),
  ticketsSkipped: z.array(z.object({
    ticketId: z.string(),
    reason: z.string(),
  })),
  summary: z.string(),
  nextActions: z.string().nullable(),
});

export type MergeQueueResult = z.infer<typeof mergeQueueResultSchema>;

export type AgenticMergeQueueTicket = {
  ticketId: string;
  ticketTitle: string;
  ticketCategory: string;
  priority: "critical" | "high" | "medium" | "low";
  reportComplete: boolean;
  landed: boolean;
  filesModified: string[];
  filesCreated: string[];
  worktreePath: string;
};

export type AgenticMergeQueueProps = {
  ctx: SmithersCtx<any>;
  outputs: any;
  tickets: AgenticMergeQueueTicket[];
  agent: any;
  postLandChecks: string[];
  preLandChecks: string[];
  repoRoot: string;
  mainBranch?: string;
  maxSpeculativeDepth?: number;
  output: any;
};

const PRIORITY_ORDER: Record<AgenticMergeQueueTicket["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function buildQueueStatusTable(tickets: AgenticMergeQueueTicket[]): string {
  const sorted = [...tickets].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  const header = "| # | Ticket ID | Title | Category | Priority | Files Touched | Worktree |";
  const separator = "|---|-----------|-------|----------|----------|---------------|----------|";
  const rows = sorted.map(
    (t, i) => {
      const allFiles = [...(t.filesModified ?? []), ...(t.filesCreated ?? [])];
      const fileSummary = allFiles.length > 0 ? allFiles.slice(0, 5).join(", ") + (allFiles.length > 5 ? ` (+${allFiles.length - 5} more)` : "") : "(unknown)";
      return `| ${i + 1} | ${t.ticketId} | ${t.ticketTitle} | ${t.ticketCategory} | ${t.priority} | ${fileSummary} | ${t.worktreePath} |`;
    },
  );

  return [header, separator, ...rows].join("\n");
}

function buildFileOverlapAnalysis(tickets: AgenticMergeQueueTicket[]): string {
  const fileToTickets = new Map<string, string[]>();
  for (const t of tickets) {
    for (const f of [...(t.filesModified ?? []), ...(t.filesCreated ?? [])]) {
      const existing = fileToTickets.get(f) ?? [];
      existing.push(t.ticketId);
      fileToTickets.set(f, existing);
    }
  }
  const conflicts = [...fileToTickets.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([file, ids]) => `- \`${file}\` touched by: ${ids.join(", ")}`);

  if (conflicts.length === 0) return "No file overlaps detected — all tickets can be landed in parallel.";
  return `**File overlaps detected** (land these tickets sequentially, not speculatively):\n${conflicts.join("\n")}`;
}

function buildMergeQueuePrompt(
  tickets: AgenticMergeQueueTicket[],
  repoRoot: string,
  mainBranch: string,
  preLandChecks: string[],
  postLandChecks: string[],
  maxSpeculativeDepth: number,
): string {
  const readyTickets = tickets.filter((t) => t.reportComplete && !t.landed);
  const queueTable = buildQueueStatusTable(readyTickets);

  const preLandCmds = preLandChecks.length
    ? preLandChecks.map((cmd) => `  - \`${cmd}\``).join("\n")
    : "  - (none configured)";

  const postLandCmds = postLandChecks.length
    ? postLandChecks.map((cmd) => `  - \`${cmd}\``).join("\n")
    : "  - (none configured)";

  const overlapAnalysis = buildFileOverlapAnalysis(readyTickets);

  return `# Merge Queue Coordinator

You are the **merge queue coordinator**. You run on the \`${mainBranch}\` branch directly (not in a worktree).
Your job is to land completed tickets onto \`${mainBranch}\` in priority order.

## Current Time
${new Date().toISOString()}

## Repository
- Root: \`${repoRoot}\`
- Main branch: \`${mainBranch}\`
- Max speculative depth: ${maxSpeculativeDepth}

## Queue Status (${readyTickets.length} ticket(s) ready to land)

${queueTable}

## File Overlap Analysis

${overlapAnalysis}

**IMPORTANT:** When file overlaps exist, land non-overlapping tickets first (they can be speculative). Then land overlapping tickets one-by-one sequentially, rebasing each onto the updated ${mainBranch} before attempting the next. This prevents the systematic rebase conflicts seen when all tickets diverge from the same base.

## Instructions

Process tickets in **priority order** (critical > high > medium > low). For each ticket:

1. **Pre-land checks** — Run these in the ticket's worktree to verify it's still healthy:
${preLandCmds}

2. **Rebase onto ${mainBranch}** — Rebase the ticket branch onto the current tip of ${mainBranch}:
   \`\`\`
   jj rebase -b bookmark("ticket/{ticketId}") -d ${mainBranch}
   \`\`\`
   If conflicts occur, attempt to understand the conflict. If it's trivially resolvable (e.g. lockfile, generated code), resolve it. Otherwise evict the ticket with detailed context about what conflicted and why.

3. **Post-land checks** — Run CI checks after rebase to verify the merged result:
${postLandCmds}

4. **Fast-forward ${mainBranch}** — If all checks pass:
   \`\`\`
   jj bookmark set ${mainBranch} -r bookmark("ticket/{ticketId}")
   \`\`\`

5. **Push** — Push the updated ${mainBranch}:
   \`\`\`
   jj git push --bookmark ${mainBranch}
   \`\`\`

6. **Cleanup** — Delete the ticket bookmark and close the worktree:
   \`\`\`
   jj bookmark delete ticket/{ticketId}
   jj workspace close {worktreeName}
   \`\`\`

## Handling Failures

- **Merge conflicts**: Inspect the conflict markers. If trivially resolvable, resolve and continue. If complex, evict the ticket with:
  - Which files conflicted
  - What the conflicting changes are
  - What landed on ${mainBranch} since the ticket branched that caused the conflict
- **CI failures**: Check if the failure is flaky (retry once). If it fails again, evict with the full CI output.
- **Push failures**: This usually means ${mainBranch} moved. Fetch, re-rebase, and retry. If it fails 3 times, evict.

## Available jj Operations

All operations use \`jj\` (NOT git). Key commands:
- \`jj rebase -b bookmark("ticket/{ticketId}") -d ${mainBranch}\` — Rebase ticket onto main
- \`jj bookmark set ${mainBranch} -r bookmark("ticket/{ticketId}")\` — Fast-forward main
- \`jj git push --bookmark ${mainBranch}\` — Push main to remote
- \`jj git fetch\` — Fetch latest from remote
- \`jj log -r "main..bookmark(\\"ticket/{ticketId}\\")" --reversed\` — Show ticket commits
- \`jj diff -r "roots(main..bookmark(\\"ticket/{ticketId}\\"))" --summary\` — Show changed files
- \`jj bookmark delete ticket/{ticketId}\` — Remove ticket bookmark
- \`jj workspace close {name}\` — Close a worktree

## Output Format

Return a JSON object matching this schema:
- \`ticketsLanded\`: Array of tickets you successfully landed, with their merge commit hash and a short summary
- \`ticketsEvicted\`: Array of tickets you evicted, with the reason and detailed context
- \`ticketsSkipped\`: Array of tickets you skipped (not ready, already landed, etc.) with reason
- \`summary\`: One paragraph summarizing what happened this merge queue run
- \`nextActions\`: Any follow-up actions needed (e.g. "ticket X needs conflict resolution"), or null`;
}

export function AgenticMergeQueue({
  tickets,
  agent,
  postLandChecks,
  preLandChecks,
  repoRoot,
  mainBranch = "main",
  maxSpeculativeDepth = 4,
  output,
}: AgenticMergeQueueProps) {
  const readyTickets = tickets.filter((t) => t.reportComplete && !t.landed);

  if (readyTickets.length === 0) {
    return null;
  }

  const prompt = buildMergeQueuePrompt(
    tickets,
    repoRoot,
    mainBranch,
    preLandChecks,
    postLandChecks,
    maxSpeculativeDepth,
  );

  return (
    <Task
      id="agentic-merge-queue"
      output={output}
      agent={agent}
      retries={2}
    >
      {prompt}
    </Task>
  );
}

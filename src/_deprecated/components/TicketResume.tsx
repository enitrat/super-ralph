import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { getResumableTickets, pipelineStageIndex, type CrossRunTicketState } from "../durability";

export type TicketResumeProps = {
  ctx: SmithersCtx<any>;
  dbPath: string;
  agent: any;
  output: any;
  onResume?: (tickets: CrossRunTicketState[]) => void;
};

export function TicketResume({ ctx, dbPath, agent, output, onResume }: TicketResumeProps) {
  const resumable = getResumableTickets(dbPath, ctx.runId);

  if (resumable.length === 0) return null;

  const sorted = [...resumable].sort((a, b) => pipelineStageIndex(b.pipelineStage) - pipelineStageIndex(a.pipelineStage));

  const ticketTable = sorted.map(t =>
    `| ${t.ticketId} | ${t.pipelineStage} | run:${t.latestRunId.slice(0, 8)} | iter:${t.iteration} |`
  ).join("\n");

  return (
    <Task id="resume-tickets" output={output} agent={agent} retries={1}>
      {`TICKET RESUME CHECK

The following ${sorted.length} tickets were in-progress from previous runs but never landed.
They should be resumed in the current run before discovering new tickets.

| Ticket ID | Pipeline Stage | Last Run | Iteration |
|-----------|---------------|----------|-----------|
${ticketTable}

For each ticket:
1. Check if the ticket's worktree/branch still exists (jj bookmark list | grep ticket/{ticketId})
2. If the branch exists and has changes, report it as resumable
3. If the branch is gone, report it as needing fresh start
4. Prioritize tickets further in the pipeline (report > review > test > implement > research)

Return the list of tickets that should be resumed with their current state, prioritized by pipeline stage.
Tickets at the review_fix or report stage should be highest priority — they're almost done.`}
    </Task>
  );
}

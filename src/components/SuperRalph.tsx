import { Ralph, Parallel, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";
import type { SuperRalphContext } from "../hooks/useSuperRalph";
import { useSuperRalph } from "../hooks/useSuperRalph";
import React from "react";

export type SuperRalphPrompts = {
  UpdateProgress: React.ComponentType<{ completedTickets: string[] }>;
  Discover: React.ComponentType<{
    categories: any[];
    completedTicketIds: string[];
    previousProgress: string | null;
    reviewFindings: string | null;
  }>;
};

export type SuperRalphAgents = {
  updateProgress: { agent: any; fallback: any };
  discover: { agent: any; fallback: any };
};

export type SuperRalphProps = {
  ctx?: SmithersCtx<any>;
  superRalphCtx?: SuperRalphContext;
  prompts: SuperRalphPrompts;
  agents: SuperRalphAgents;
  maxConcurrency: number;
  taskRetries: number;
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
  target: any;
  CodebaseReview: React.ComponentType<{ target: any }>;
  TicketPipeline: React.ComponentType<{ target: any; ticket: any; ctx: SmithersCtx<any> }>;
  IntegrationTest: React.ComponentType<{ target: any }>;
  skipPhases?: Set<string>;
};

export function SuperRalph({
  ctx,
  superRalphCtx,
  prompts,
  agents,
  maxConcurrency,
  taskRetries,
  categories,
  outputs,
  target,
  CodebaseReview,
  TicketPipeline,
  IntegrationTest,
  skipPhases = new Set(),
}: SuperRalphProps) {
  // Controlled component: use provided superRalphCtx, or compute it from ctx
  const workflowState = superRalphCtx ?? (ctx ? useSuperRalph(ctx, { categories, outputs }) : null);

  if (!workflowState) {
    throw new Error("SuperRalph requires either ctx or superRalphCtx prop");
  }

  const { completedTicketIds, unfinishedTickets, reviewFindings } = workflowState;
  const { UpdateProgress, Discover } = prompts;

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {!skipPhases.has("PROGRESS") && (
          <Task
            id="update-progress"
            output={outputs.progress}
            agent={agents.updateProgress.agent}
            fallbackAgent={agents.updateProgress.fallback}
            retries={taskRetries}
          >
            <UpdateProgress completedTickets={completedTicketIds} />
          </Task>
        )}

        {!skipPhases.has("CODEBASE_REVIEW") && <CodebaseReview target={target} />}

        {!skipPhases.has("DISCOVER") && (
          <Task
            id="discover"
            output={outputs.discover}
            agent={agents.discover.agent}
            fallbackAgent={agents.discover.fallback}
            retries={taskRetries}
          >
            <Discover
              categories={categories}
              completedTicketIds={completedTicketIds}
              previousProgress={workflowState.progressSummary}
              reviewFindings={reviewFindings}
            />
          </Task>
        )}

        {!skipPhases.has("INTEGRATION_TEST") && <IntegrationTest target={target} />}

        {unfinishedTickets.map((ticket: any) => (
          <Worktree key={ticket.id} id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
            <TicketPipeline target={target} ticket={ticket} ctx={ctx!} />
          </Worktree>
        ))}
      </Parallel>
    </Ralph>
  );
}

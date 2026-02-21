import { Ralph, Parallel, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";
import type { SuperRalphContext } from "../hooks/useSuperRalph";
import { useSuperRalph } from "../hooks/useSuperRalph";
import React from "react";
import UpdateProgressPrompt from "../prompts/UpdateProgress.mdx";
import DiscoverPrompt from "../prompts/Discover.mdx";
import { IntegrationTest as DefaultIntegrationTest } from "./IntegrationTest";

export type SuperRalphAgents = {
  updateProgress: { agent: any; fallback: any };
  discover: { agent: any; fallback: any };
  integrationTest: { agent: any; fallback: any };
};

export type SuperRalphPromptConfig = {
  projectName: string;
  progressFile: string;
  findingsFile: string;
  commitMessage?: string;
};

export type SuperRalphProps = {
  superRalphCtx: SuperRalphContext;
  ctx: SmithersCtx<any>;
  promptConfig: SuperRalphPromptConfig;
  agents: SuperRalphAgents;
  maxConcurrency: number;
  taskRetries: number;
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
  target: any;
  categoryTestSuites: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  CodebaseReview: React.ComponentType<{ target: any }>;
  TicketPipeline: React.ComponentType<{ target: any; ticket: any; ctx: SmithersCtx<any> }>;
  IntegrationTest?: React.ComponentType<any>;
  skipPhases?: Set<string>;
};

export function SuperRalph({
  superRalphCtx,
  ctx,
  promptConfig,
  agents,
  maxConcurrency,
  taskRetries,
  categories,
  outputs,
  target,
  categoryTestSuites,
  CodebaseReview,
  TicketPipeline,
  IntegrationTest = DefaultIntegrationTest,
  skipPhases = new Set(),
}: SuperRalphProps) {
  const { completedTicketIds, unfinishedTickets, reviewFindings, progressSummary } = superRalphCtx;

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
            <UpdateProgressPrompt
              projectName={promptConfig.projectName}
              progressFile={promptConfig.progressFile}
              commitMessage={promptConfig.commitMessage}
              completedTickets={completedTicketIds}
            />
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
            <DiscoverPrompt
              projectName={promptConfig.projectName}
              specsPath={target.specsPath}
              referenceFiles={target.referenceFiles}
              categories={categories}
              completedTicketIds={completedTicketIds}
              previousProgress={progressSummary}
              reviewFindings={reviewFindings}
            />
          </Task>
        )}

        {!skipPhases.has("INTEGRATION_TEST") && (
          <IntegrationTest
            categories={categories}
            outputs={outputs}
            agent={agents.integrationTest.agent}
            fallbackAgent={agents.integrationTest.fallback}
            taskRetries={taskRetries}
            maxConcurrency={maxConcurrency}
            categoryTestSuites={categoryTestSuites}
            findingsFile={promptConfig.findingsFile}
          />
        )}

        {unfinishedTickets.map((ticket: any) => (
          <Worktree key={ticket.id} id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
            <TicketPipeline target={target} ticket={ticket} ctx={ctx} />
          </Worktree>
        ))}
      </Parallel>
    </Ralph>
  );
}

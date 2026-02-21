import { Ralph, Parallel, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";
import type { SuperRalphContext } from "../hooks/useSuperRalph";
import React from "react";
import UpdateProgressPrompt from "../prompts/UpdateProgress.mdx";
import DiscoverPrompt from "../prompts/Discover.mdx";
import IntegrationTestPrompt from "../prompts/IntegrationTest.mdx";

// Child component types
type UpdateProgressProps = {
  agent: any;
  fallbackAgent: any;
  projectName: string;
  progressFile: string;
  commitMessage?: string;
};

type DiscoverProps = {
  agent: any;
  fallbackAgent: any;
  specsPath: string;
  referenceFiles: string[];
};

type IntegrationTestProps = {
  agent: any;
  fallbackAgent: any;
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  categoryTestSuites: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  findingsFile: string;
};

type CodebaseReviewProps = {
  target: any;
  children: React.ReactElement;
};

type TicketPipelineProps = {
  target: any;
  children: React.ReactElement;
};

// Main component props
export type SuperRalphProps = {
  superRalphCtx: SuperRalphContext;
  maxConcurrency: number;
  taskRetries: number;
  skipPhases?: Set<string>;
  updateProgress: React.ReactElement<UpdateProgressProps>;
  discover: React.ReactElement<DiscoverProps>;
  integrationTest: React.ReactElement<IntegrationTestProps>;
  codebaseReview: React.ReactElement<CodebaseReviewProps>;
  ticketPipeline: React.ReactElement<TicketPipelineProps>;
};

export function SuperRalph({
  superRalphCtx,
  maxConcurrency,
  taskRetries,
  skipPhases = new Set(),
  updateProgress,
  discover,
  integrationTest,
  codebaseReview,
  ticketPipeline,
}: SuperRalphProps) {
  const { ctx, completedTicketIds, unfinishedTickets, reviewFindings, progressSummary, categories, outputs, target } = superRalphCtx;

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {!skipPhases.has("PROGRESS") && (
          <Task
            id="update-progress"
            output={outputs.progress}
            agent={updateProgress.props.agent}
            fallbackAgent={updateProgress.props.fallbackAgent}
            retries={taskRetries}
          >
            <UpdateProgressPrompt
              projectName={updateProgress.props.projectName}
              progressFile={updateProgress.props.progressFile}
              commitMessage={updateProgress.props.commitMessage}
              completedTickets={completedTicketIds}
            />
          </Task>
        )}

        {!skipPhases.has("CODEBASE_REVIEW") && React.cloneElement(codebaseReview.props.children, { target: codebaseReview.props.target })}

        {!skipPhases.has("DISCOVER") && (
          <Task
            id="discover"
            output={outputs.discover}
            agent={discover.props.agent}
            fallbackAgent={discover.props.fallbackAgent}
            retries={taskRetries}
          >
            <DiscoverPrompt
              projectName={updateProgress.props.projectName}
              specsPath={discover.props.specsPath}
              referenceFiles={discover.props.referenceFiles}
              categories={categories}
              completedTicketIds={completedTicketIds}
              previousProgress={progressSummary}
              reviewFindings={reviewFindings}
            />
          </Task>
        )}

        {!skipPhases.has("INTEGRATION_TEST") && (
          <Parallel maxConcurrency={maxConcurrency}>
            {categories.map(({ id, name }) => {
              const suiteInfo = integrationTest.props.categoryTestSuites[id] ?? { suites: [], setupHints: [], testDirs: [] };
              return (
                <Task
                  key={id}
                  id={`integration-test:${id}`}
                  output={outputs.integration_test}
                  agent={integrationTest.props.agent}
                  fallbackAgent={integrationTest.props.fallbackAgent}
                  retries={taskRetries}
                >
                  <IntegrationTestPrompt
                    categoryId={id}
                    categoryName={name}
                    suites={suiteInfo.suites}
                    setupHints={suiteInfo.setupHints}
                    testDirs={suiteInfo.testDirs}
                    findingsFile={integrationTest.props.findingsFile}
                  />
                </Task>
              );
            })}
          </Parallel>
        )}

        {unfinishedTickets.map((ticket: any) => (
          <Worktree key={ticket.id} id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
            {React.cloneElement(ticketPipeline.props.children, { target: ticketPipeline.props.target, ticket, ctx })}
          </Worktree>
        ))}
      </Parallel>
    </Ralph>
  );
}

// Compound components
function UpdateProgress(_props: UpdateProgressProps) {
  return null;
}

function Discover(_props: DiscoverProps) {
  return null;
}

function IntegrationTest(_props: IntegrationTestProps) {
  return null;
}

function CodebaseReview(_props: CodebaseReviewProps) {
  return null;
}

function TicketPipeline(_props: TicketPipelineProps) {
  return null;
}

SuperRalph.UpdateProgress = UpdateProgress;
SuperRalph.Discover = Discover;
SuperRalph.IntegrationTest = IntegrationTest;
SuperRalph.CodebaseReview = CodebaseReview;
SuperRalph.TicketPipeline = TicketPipeline;

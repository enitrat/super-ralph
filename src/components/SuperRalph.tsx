import { Ralph, Parallel } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { selectAllTickets, selectProgressSummary, selectLand, selectImplement, isTicketTierComplete } from "../selectors";
import type { RalphOutputs, Ticket } from "../selectors";
import React from "react";
import { Database } from "bun:sqlite";
import { computePipelineStage, isJobComplete, type TicketSchedule, type TicketState } from "./TicketScheduler";
import { TicketScheduler } from "./TicketScheduler";
import { AgenticMergeQueue } from "./AgenticMergeQueue";
import { Job } from "./Job";
import { ensureTable, insertJob, removeJob, getActiveJobs, type ScheduledJob } from "../scheduledTasks";
import { getResumableTickets, type CrossRunTicketState } from "../durability";

// --- Props ---

export type SuperRalphProps = {
  ctx: SmithersCtx<RalphOutputs>;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: RalphOutputs;

  projectName: string;
  specsPath: string;
  referenceFiles: string[];
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  codeStyle: string;
  reviewChecklist: string[];

  maxConcurrency: number;
  taskRetries?: number;

  agents: Record<string, {
    agent: ClaudeCodeAgent | CodexAgent;
    description: string;
    isScheduler?: boolean;
    isMergeQueue?: boolean;
  }>;

  dbPath?: string;
  progressFile?: string;
  findingsFile?: string;
  commitConfig?: { prefix?: string; mainBranch?: string; emojiPrefixes?: string };
  testSuites?: Array<{ name: string; command: string; description: string }>;
  preLandChecks?: string[];
  postLandChecks?: string[];
  maxSpeculativeDepth?: number;
  repoRoot?: string;
};

type AgentPool = Record<string, { agent: ClaudeCodeAgent | CodexAgent; description: string; isScheduler?: boolean; isMergeQueue?: boolean }>;

function resolveAgent(pool: AgentPool, agentId: string | undefined): AgentLike {
  if (agentId && pool[agentId]) return pool[agentId].agent;
  return Object.values(pool)[0]?.agent;
}

function buildAgentPoolDescription(pool: AgentPool): string {
  const entries = Object.entries(pool);
  if (entries.length === 0) return "(no agents registered)";
  const rows = entries.map(([id, { description }]) => `| ${id} | ${description} |`);
  return ["| Agent ID | Description |", "|----------|-------------|", ...rows].join("\n");
}

// --- Main Component ---

export function SuperRalph({
  ctx, focuses, outputs,
  projectName, specsPath, referenceFiles, buildCmds, testCmds,
  codeStyle, reviewChecklist, maxConcurrency, taskRetries = 3,
  agents: agentPool,
  dbPath = "./scheduled-tasks.db",
  progressFile = "PROGRESS.md",
  findingsFile = "docs/test-suite-findings.md",
  commitConfig = {},
  testSuites = [],
  preLandChecks = [],
  postLandChecks = [],
  maxSpeculativeDepth = 3,
  repoRoot = process.cwd(),
}: SuperRalphProps) {

  const { completed: completedTicketIds, unfinished: unfinishedTickets } = selectAllTickets(ctx);
  const progressSummary = selectProgressSummary(ctx);
  const { prefix = "📝", mainBranch = "main", emojiPrefixes = "✨ feat, 🐛 fix, ♻️ refactor, 📝 docs, 🧪 test" } = commitConfig;

  // Resolve scheduler + merge queue agents from pool flags
  const agentIds = Object.keys(agentPool);
  const defaultAgentId = agentIds[0];
  const schedulerAgentId = Object.entries(agentPool).find(([, e]) => e.isScheduler)?.[0] ?? defaultAgentId;
  const mergeQueueAgentId = Object.entries(agentPool).find(([, e]) => e.isMergeQueue)?.[0] ?? schedulerAgentId;
  const schedulerAgent = resolveAgent(agentPool, schedulerAgentId);
  const agentPoolContext = buildAgentPoolDescription(agentPool);
  const ciCommands = postLandChecks.length > 0 ? postLandChecks : Object.values(testCmds);

  // Lookups
  const ticketMap = new Map<string, Ticket>(unfinishedTickets.map(t => [t.id, t]));

  // Ticket pipeline states (for scheduler context)
  const ticketStates: TicketState[] = unfinishedTickets.map(ticket => ({
    ticket,
    pipelineStage: computePipelineStage(ctx, ticket.id),
    landed: selectLand(ctx, ticket.id)?.merged === true,
    tierComplete: (() => {
      const land = selectLand(ctx, ticket.id);
      const evicted = land?.evicted === true && land?.merged !== true;
      if (evicted) return false;
      return isTicketTierComplete(ctx, ticket.id, ticket.complexityTier);
    })(),
  }));

  // Merge queue tickets — tier-complete tickets are ready to land
  const mergeQueueTickets = ticketStates
    .filter(t => t.tierComplete && !t.landed)
    .map(t => ({
      ticketId: t.ticket.id, ticketTitle: t.ticket.title,
      ticketCategory: t.ticket.category, priority: t.ticket.priority,
      reportComplete: t.tierComplete, landed: t.landed,
      filesModified: selectImplement(ctx, t.ticket.id)?.filesModified ?? [],
      filesCreated: selectImplement(ctx, t.ticket.id)?.filesCreated ?? [],
      worktreePath: `/tmp/workflow-wt-${t.ticket.id}`,
    }));

  // --- Scheduled tasks: reap → reconcile → read ---
  const db = new Database(dbPath);
  ensureTable(db);

  for (const job of getActiveJobs(db)) {
    if (isJobComplete(ctx, job)) removeJob(db, job.jobId);
  }

  const schedulerOutput = ctx.latest("ticket_schedule" as any, "ticket-scheduler") as TicketSchedule | undefined;
  if (schedulerOutput?.jobs) {
    for (const job of schedulerOutput.jobs) {
      const scheduled: ScheduledJob = { jobId: job.jobId, jobType: job.jobType, agentId: job.agentId, ticketId: job.ticketId ?? null, createdAtMs: Date.now() };
      if (!isJobComplete(ctx, scheduled)) {
        insertJob(db, scheduled);
      }
    }
  }

  const activeJobs = getActiveJobs(db);
  const activeCount = activeJobs.length;
  db.close();

  // Check for resumable tickets from previous runs
  const resumableTickets = getResumableTickets(dbPath, ctx.runId);

  // Shared props for <Job /> components
  const jobProps = {
    ctx, outputs, retries: taskRetries,
    ticketMap,
    projectName, specsPath, referenceFiles, buildCmds, testCmds,
    codeStyle, reviewChecklist, progressFile, findingsFile,
    prefix, mainBranch, emojiPrefixes, testSuites,
    completedTicketIds, unfinishedTickets, progressSummary, focuses,
  };

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {activeCount < maxConcurrency && (
          <TicketScheduler
            ctx={ctx} ticketStates={ticketStates} activeJobs={activeJobs}
            agentPoolContext={agentPoolContext} focuses={focuses}
            maxConcurrency={maxConcurrency} agent={schedulerAgent}
            output={outputs.ticket_schedule} completedTicketIds={completedTicketIds}
            resumableTickets={resumableTickets}
          />
        )}

        {activeJobs.map(job => (
          <Job key={job.jobId} job={job} agent={resolveAgent(agentPool, job.agentId)} {...jobProps} />
        ))}

        <AgenticMergeQueue
          ctx={ctx} outputs={outputs} tickets={mergeQueueTickets}
          agent={resolveAgent(agentPool, mergeQueueAgentId)}
          postLandChecks={ciCommands} preLandChecks={preLandChecks}
          repoRoot={repoRoot} mainBranch={mainBranch}
          maxSpeculativeDepth={maxSpeculativeDepth} output={outputs.merge_queue_result}
        />
      </Parallel>
    </Ralph>
  );
}

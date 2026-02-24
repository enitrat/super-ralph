/**
 * Super Ralph - Reusable Ralph workflow pattern
 *
 * Encapsulates the ticket-driven development workflow with:
 * - Multi-agent code review
 * - TDD validation loops
 * - Automated ticket discovery and prioritization
 * - Stacked ticket processing with worktrees
 *
 * Extracted from Plue workflow, generalized for reuse.
 */

import {
  selectAllTickets,
  selectReviewTickets,
  selectDiscoverTickets,
  selectCompletedTicketIds,
  selectProgressSummary,
  selectTicketReport,
  selectResearch,
  selectPlan,
  selectImplement,
  selectTestResults,
  selectSpecReview,
  selectCodeReviews,
  selectClarifyingQuestions,
  selectInterpretConfig,
  selectMonitor,
  selectTicketPipelineStage,
} from "./selectors";

import type { Ticket, RalphOutputs } from "./selectors";

import {
  SuperRalph,
  Job,
  ClarifyingQuestions,
  InterpretConfig,
  Monitor,
  TicketResume,
  TicketScheduler,
  ticketScheduleSchema,
  scheduledJobSchema,
  computePipelineStage,
  isJobComplete,
  JOB_TYPE_TO_OUTPUT_KEY,
  AgenticMergeQueue,
  mergeQueueResultSchema,
  clarifyingQuestionsOutputSchema,
  interpretConfigOutputSchema,
  monitorOutputSchema,
} from "./components";

import {
  AgentRegistry,
  getAgentRegistry,
  resetAgentRegistry,
} from "./agentRegistry";
import type { AgentMetadata, AgentStats, AgentRegistrySnapshot } from "./agentRegistry";

import {
  loadCrossRunTicketState,
  getResumableTickets,
  pipelineStageIndex,
} from "./durability";
import type { SuperRalphProps } from "./components/SuperRalph";
import type { JobProps } from "./components/Job";
import type { ClarifyingQuestionsOutput, ClarifyingQuestionsProps } from "./components/ClarifyingQuestions";
import type { InterpretConfigOutput, InterpretConfigProps } from "./components/InterpretConfig";
import type { MonitorOutput, MonitorProps } from "./components/Monitor";
import type { TicketResumeProps } from "./components/TicketResume";
import type { TicketSchedule, TicketScheduleJob, TicketSchedulerProps, TicketState } from "./components/TicketScheduler";
import type { AgenticMergeQueueProps, AgenticMergeQueueTicket, MergeQueueResult } from "./components/AgenticMergeQueue";
import type { CrossRunTicketState } from "./durability";
import { useSuperRalph } from "./hooks/useSuperRalph";
import type { SuperRalphContext, UseSuperRalphConfig } from "./hooks/useSuperRalph";
import { ralphOutputSchemas } from "./schemas";

export {
  // Selectors
  selectAllTickets,
  selectReviewTickets,
  selectDiscoverTickets,
  selectCompletedTicketIds,
  selectProgressSummary,
  selectTicketReport,
  selectResearch,
  selectPlan,
  selectImplement,
  selectTestResults,
  selectSpecReview,
  selectCodeReviews,
  selectClarifyingQuestions,
  selectInterpretConfig,
  selectMonitor,
  selectTicketPipelineStage,

  // Hooks
  useSuperRalph,

  // Components
  SuperRalph,
  Job,
  ClarifyingQuestions,
  InterpretConfig,
  Monitor,
  TicketResume,
  TicketScheduler,
  ticketScheduleSchema,
  scheduledJobSchema,
  computePipelineStage,
  isJobComplete,
  JOB_TYPE_TO_OUTPUT_KEY,
  AgenticMergeQueue,
  mergeQueueResultSchema,

  // Agent Registry
  AgentRegistry,
  getAgentRegistry,
  resetAgentRegistry,

  // Durability
  loadCrossRunTicketState,
  getResumableTickets,
  pipelineStageIndex,

  // Schemas
  ralphOutputSchemas,
  clarifyingQuestionsOutputSchema,
  interpretConfigOutputSchema,
  monitorOutputSchema,
};

export type {
  Ticket,
  RalphOutputs,
  SuperRalphProps,
  JobProps,
  SuperRalphContext,
  UseSuperRalphConfig,
  ClarifyingQuestionsOutput,
  ClarifyingQuestionsProps,
  InterpretConfigOutput,
  InterpretConfigProps,
  MonitorOutput,
  MonitorProps,
  TicketResumeProps,
  TicketSchedule,
  TicketScheduleJob,
  TicketSchedulerProps,
  TicketState,
  AgenticMergeQueueProps,
  AgenticMergeQueueTicket,
  MergeQueueResult,
  AgentMetadata,
  AgentStats,
  AgentRegistrySnapshot,
  CrossRunTicketState,
};

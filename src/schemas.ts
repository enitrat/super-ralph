import { z } from "zod";
import { interpretConfigOutputSchema } from "./components/InterpretConfig";
import { monitorOutputSchema } from "./components/Monitor";
import { ticketScheduleSchema } from "./components/TicketScheduler";
import { mergeQueueResultSchema } from "./components/AgenticMergeQueue";

// Extracted from ClarifyingQuestions.tsx (moved to _deprecated)
export const generateQuestionsOutputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    choices: z.array(z.object({
      label: z.string(),
      description: z.string(),
      value: z.string(),
    })),
  })),
});

export const clarifyingQuestionsOutputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    choices: z.array(z.object({
      label: z.string(),
      description: z.string(),
      value: z.string(),
    })),
  })),
  answers: z.array(z.object({
    question: z.string(),
    answer: z.string(),
    isCustom: z.boolean(),
  })),
  session: z.object({
    answers: z.array(z.object({
      question: z.string(),
      answer: z.string(),
      isCustom: z.boolean(),
    })),
    summary: z.string(),
  }),
});

/**
 * Complexity tiers control which pipeline stages a ticket must complete.
 * Assigned at discovery time based on the ticket's estimated scope.
 *
 * - trivial: Comment cleanup, JSDoc, constant extraction, 1-line config changes
 * - small:   Single-file refactors, type exports, adding test cases
 * - medium:  Multi-file features, API changes, hook refactors
 * - large:   Architectural changes, new subsystems, security-sensitive work
 */
export const COMPLEXITY_TIERS = {
  trivial: ["implement", "build-verify"] as const,
  small:   ["implement", "test", "build-verify"] as const,
  medium:  ["research", "plan", "implement", "test", "build-verify", "code-review"] as const,
  large:   ["research", "plan", "implement", "test", "build-verify", "spec-review", "code-review", "review-fix", "report"] as const,
} as const;

export type ComplexityTier = keyof typeof COMPLEXITY_TIERS;

/** Get the pipeline stages for a given tier */
export function getTierStages(tier: ComplexityTier): readonly string[] {
  return COMPLEXITY_TIERS[tier];
}

/** Get the final required stage for a tier (used for "ready to land" detection) */
export function getTierFinalStage(tier: ComplexityTier): string {
  const stages = COMPLEXITY_TIERS[tier];
  return stages[stages.length - 1];
}

/** Check if a given stage is part of a tier's pipeline */
export function isTierStage(tier: ComplexityTier, stage: string): boolean {
  return (COMPLEXITY_TIERS[tier] as readonly string[]).includes(stage);
}

/**
 * Standard output schemas for Ralph workflow pattern.
 * Use these or extend them for your project.
 */

const discoverTicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
  complexityTier: z.enum(["trivial", "small", "medium", "large"])
    .describe("Pipeline depth tier — trivial (2 stages) to large (full 9-stage pipeline)"),
  acceptanceCriteria: z.array(z.string()).nullable(),
  relevantFiles: z.array(z.string()).nullable(),
  referenceFiles: z.array(z.string()).nullable(),
});

export const ralphOutputSchemas = {
  generate_questions: generateQuestionsOutputSchema,
  clarifying_questions: clarifyingQuestionsOutputSchema,
  interpret_config: interpretConfigOutputSchema,
  monitor: monitorOutputSchema,

  progress: z.object({
    progressFilePath: z.string().nullable(),
    summary: z.string(),
    ticketsCompleted: z.array(z.string()).nullable(),
    ticketsRemaining: z.array(z.string()).nullable(),
  }),

  discover: z.object({
    tickets: z.array(discoverTicketSchema),
    reasoning: z.string(),
    completionEstimate: z.string(),
  }),

  research: z.object({
    contextFilePath: z.string(),
    summary: z.string(),
  }),

  plan: z.object({
    planFilePath: z.string(),
    implementationSteps: z.array(z.string()).nullable(),
  }),

  implement: z.object({
    whatWasDone: z.string(),
    filesCreated: z.array(z.string()).nullable(),
    filesModified: z.array(z.string()).nullable(),
    nextSteps: z.string().nullable(),
  }),

  test_results: z.object({
    allPassed: z.boolean().describe("True if every suite passed"),
    suiteResults: z.array(z.object({
      name: z.string().describe("Suite name (e.g. 'unit', 'integration', 'e2e')"),
      passed: z.boolean(),
      summary: z.string().nullable().describe("Details on failures, if any"),
    })).nullable().describe("Per-suite breakdown, null if not available"),
    failingSummary: z.string().nullable(),
  }),

  build_verify: z.object({
    buildPassed: z.boolean(),
    errors: z.array(z.string()).nullable(),
  }),

  spec_review: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  code_review: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  code_review_codex: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  code_review_gemini: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  review_fix: z.object({
    allIssuesResolved: z.boolean(),
    summary: z.string(),
  }),

  report: z.object({
    ticketId: z.string(),
    status: z.enum(["partial", "complete", "blocked"]),
    summary: z.string(),
    filesChanged: z.array(z.string()).nullable(),
    testsAdded: z.array(z.string()).nullable(),
    reviewRounds: z.number(),
    struggles: z.array(z.string()).nullable(),
    lessonsLearned: z.array(z.string()).nullable(),
  }),

  land: z.object({
    merged: z.boolean(),
    mergeCommit: z.string().nullable(),
    ciPassed: z.boolean(),
    summary: z.string(),
    evicted: z.boolean().default(false),
    evictionReason: z.string().nullable(),
    evictionDetails: z.string().nullable(),
    attemptedLog: z.string().nullable(),
    attemptedDiffSummary: z.string().nullable(),
    landedOnMainSinceBranch: z.string().nullable(),
  }),

  ticket_schedule: ticketScheduleSchema,

  merge_queue_result: mergeQueueResultSchema,
};

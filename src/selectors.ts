import type { SmithersCtx } from "smithers-orchestrator";
import type { ralphOutputSchemas } from "./schemas";
import { COMPLEXITY_TIERS, getTierStages, getTierFinalStage, type ComplexityTier } from "./schemas";

/**
 * Generic selectors for Ralph workflow pattern.
 * These can be extended/overridden by specific workflows.
 */

export type RalphOutputs = typeof ralphOutputSchemas;
export type SchemaKey = keyof RalphOutputs & string;

export interface Ticket {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: "critical" | "high" | "medium" | "low";
  complexityTier: ComplexityTier;
  acceptanceCriteria?: string[];
  relevantFiles?: string[];
  referenceFiles?: string[];
}

const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const sortByPriority = (a: Ticket, b: Ticket) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v).trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*([-*]|\d+\.)\s+/, "").trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : [text];
  }
  return undefined;
}

function normalizePriority(value: unknown): Ticket["priority"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}

function normalizeComplexityTier(value: unknown): ComplexityTier {
  return value === "trivial" || value === "small" || value === "medium" || value === "large"
    ? value
    : "medium";
}

function normalizeTicket(raw: unknown): Ticket | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (!id) return null;
  return {
    id,
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : id,
    description: typeof source.description === "string" ? source.description : "",
    category: typeof source.category === "string" && source.category.trim() ? source.category.trim() : "general",
    priority: normalizePriority(source.priority),
    complexityTier: normalizeComplexityTier(source.complexityTier),
    acceptanceCriteria: toStringList(source.acceptanceCriteria),
    relevantFiles: toStringList(source.relevantFiles),
    referenceFiles: toStringList(source.referenceFiles),
  };
}

// Type helper for output inference
type OutputType<K extends SchemaKey> = ReturnType<SmithersCtx<RalphOutputs>["outputMaybe"]> extends infer R
  ? R
  : unknown;

export function selectDiscoverTickets(ctx: SmithersCtx<RalphOutputs>): Ticket[] {
  const allRows = ctx.outputs("discover")
    .filter((row: any) => row?.nodeId === "discovery" && Array.isArray(row?.tickets))
    .sort((a: any, b: any) => (Number(a.iteration) || 0) - (Number(b.iteration) || 0));

  const ticketMap = new Map<string, Ticket>();
  for (const row of allRows) {
    for (const candidate of (row as any).tickets) {
      const ticket = normalizeTicket(candidate);
      if (ticket) ticketMap.set(ticket.id, ticket);
    }
  }
  return Array.from(ticketMap.values());
}

export function selectCompletedTicketIds(ctx: SmithersCtx<RalphOutputs>, tickets: Ticket[]): string[] {
  return tickets
    .filter((t) => {
      const land = selectLand(ctx, t.id);
      return land?.merged === true;
    })
    .map((t) => t.id);
}

export function selectProgressSummary(ctx: SmithersCtx<RalphOutputs>): string | null {
  const progress = ctx.latest("progress", "progress-update");
  return (progress as any)?.summary ?? null;
}

export function selectAllTickets(
  ctx: SmithersCtx<RalphOutputs>,
): { all: Ticket[]; completed: string[]; unfinished: Ticket[] } {
  const all = selectDiscoverTickets(ctx).sort(sortByPriority);
  const completed = selectCompletedTicketIds(ctx, all);
  const unfinished = all.filter((t) => !completed.includes(t.id));

  return { all, completed, unfinished };
}

export function selectTicketReport(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("report", `${ticketId}:report`);
}

export function selectResearch(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("research", `${ticketId}:research`) as
    | { contextFilePath: string; summary: string }
    | undefined;
}

export function selectPlan(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("plan", `${ticketId}:plan`) as
    | { planFilePath: string; implementationSteps: string[] | null }
    | undefined;
}

export function selectImplement(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("implement", `${ticketId}:implement`) as
    | { whatWasDone: string; filesCreated: string[] | null; filesModified: string[] | null; nextSteps: string | null }
    | undefined;
}

export function selectTestResults(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("test_results", `${ticketId}:test`) as
    | { goTestsPassed: boolean; rustTestsPassed: boolean; e2eTestsPassed: boolean; sqlcGenPassed: boolean; failingSummary: string | null }
    | undefined;
}

export function selectSpecReview(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("spec_review", `${ticketId}:spec-review`) as
    | { severity: "none" | "minor" | "major" | "critical"; feedback: string; issues: string[] | null }
    | undefined;
}

export function selectLand(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  // Check direct per-ticket land rows first
  const directLand = ctx.latest("land", `${ticketId}:land`) as
    | { merged: boolean; mergeCommit: string | null; ciPassed: boolean; summary: string; evicted?: boolean; evictionReason?: string | null; evictionDetails?: string | null; attemptedLog?: string | null; attemptedDiffSummary?: string | null; landedOnMainSinceBranch?: string | null }
    | undefined;
  if (directLand) return directLand;

  // Scan merge_queue_result rows for this ticket
  const mqResults = ctx.outputs("merge_queue_result");
  for (const row of mqResults) {
    const result = row as any;
    const landed = result?.ticketsLanded?.find((t: any) => t.ticketId === ticketId);
    if (landed) {
      return {
        merged: true as const,
        mergeCommit: (landed.mergeCommit as string) ?? null,
        ciPassed: true,
        summary: (landed.summary as string) ?? "",
      };
    }
    const evicted = result?.ticketsEvicted?.find((t: any) => t.ticketId === ticketId);
    if (evicted) {
      return {
        merged: false as const,
        mergeCommit: null,
        ciPassed: false,
        summary: (evicted.reason as string) ?? "",
        evicted: true,
        evictionReason: (evicted.reason as string) ?? null,
        evictionDetails: (evicted.details as string) ?? null,
      };
    }
  }

  return undefined;
}

export function selectCodeReviews(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  const claude = ctx.latest("code_review", `${ticketId}:code-review`) as
    | { severity: string; feedback: string; issues: string[] | null }
    | undefined;
  const codex = ctx.latest("code_review_codex", `${ticketId}:code-review-codex`) as
    | { severity: string; feedback: string; issues: string[] | null }
    | undefined;
  const gemini = ctx.latest("code_review_gemini", `${ticketId}:code-review-gemini`) as
    | { severity: string; feedback: string; issues: string[] | null }
    | undefined;

  const severityRank: Record<string, number> = { critical: 3, major: 2, minor: 1, none: 0 };
  const severities = [claude?.severity, codex?.severity, gemini?.severity].filter(Boolean) as string[];
  const worstSeverity = severities.length > 0
    ? severities.reduce((worst, s) => (severityRank[s] ?? 0) > (severityRank[worst] ?? 0) ? s : worst, "none")
    : "none";

  const toArray = (v: unknown): string[] => Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const mergedIssues = [
    ...toArray(claude?.issues).map((i: string) => `[Claude] ${i}`),
    ...toArray(codex?.issues).map((i: string) => `[Codex] ${i}`),
    ...toArray(gemini?.issues).map((i: string) => `[Gemini] ${i}`),
  ];
  const mergedFeedback = [
    claude?.feedback ? `Claude: ${claude.feedback}` : null,
    codex?.feedback ? `Codex: ${codex.feedback}` : null,
    gemini?.feedback ? `Gemini: ${gemini.feedback}` : null,
  ].filter(Boolean).join("\n\n");

  return {
    claude,
    codex,
    gemini,
    worstSeverity,
    mergedIssues,
    mergedFeedback,
  };
}

export function selectClarifyingQuestions(ctx: SmithersCtx<RalphOutputs>) {
  return ctx.latest("clarifying_questions", "clarifying-questions");
}

export function selectInterpretConfig(ctx: SmithersCtx<RalphOutputs>) {
  return ctx.latest("interpret_config", "interpret-config");
}

export function selectMonitor(ctx: SmithersCtx<RalphOutputs>) {
  return ctx.latest("monitor", "monitor");
}

export function selectTicketPipelineStage(ctx: SmithersCtx<RalphOutputs>, ticketId: string): string {
  const land = selectLand(ctx, ticketId);
  if (land?.merged) return "landed";
  if (ctx.latest("report", `${ticketId}:report`)) return "report";
  if (ctx.latest("review_fix", `${ticketId}:review-fix`)) return "review_fix";
  if (ctx.latest("code_review", `${ticketId}:code-review`)) return "code_review";
  if (ctx.latest("spec_review", `${ticketId}:spec-review`)) return "spec_review";
  if (ctx.latest("build_verify", `${ticketId}:build-verify`)) return "build_verify";
  if (ctx.latest("test_results", `${ticketId}:test`)) return "test";
  if (ctx.latest("implement", `${ticketId}:implement`)) return "implement";
  if (ctx.latest("plan", `${ticketId}:plan`)) return "plan";
  if (ctx.latest("research", `${ticketId}:research`)) return "research";
  return "not_started";
}

/**
 * Check if a ticket has completed all stages required by its tier.
 * For trivial tickets, completing build-verify means ready to land.
 * For large tickets, completing report means ready to land.
 */
export function isTicketTierComplete(
  ctx: SmithersCtx<RalphOutputs>,
  ticketId: string,
  tier: ComplexityTier,
): boolean {
  const finalStage = getTierFinalStage(tier);
  // Map stage names to their output keys and node IDs
  const stageToCheck: Record<string, { output: string; nodeId: string }> = {
    "implement":    { output: "implement",    nodeId: `${ticketId}:implement` },
    "test":         { output: "test_results", nodeId: `${ticketId}:test` },
    "build-verify": { output: "build_verify", nodeId: `${ticketId}:build-verify` },
    "code-review":  { output: "code_review",  nodeId: `${ticketId}:code-review` },
    "spec-review":  { output: "spec_review",  nodeId: `${ticketId}:spec-review` },
    "review-fix":   { output: "review_fix",   nodeId: `${ticketId}:review-fix` },
    "report":       { output: "report",       nodeId: `${ticketId}:report` },
  };
  const check = stageToCheck[finalStage];
  if (!check) return false;
  return !!ctx.latest(check.output as any, check.nodeId);
}

/**
 * AgentRegistry — tracks agent performance stats, rate limits, and current assignments.
 * Used by the TicketScheduler to make dynamic agent allocation decisions.
 */

export type AgentMetadata = {
  id: string;
  type: "claude-code" | "codex" | "gemini" | "kimi" | "amp" | "custom";
  model?: string;
  costPerToken?: number;
};

export type AgentStats = AgentMetadata & {
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  avgDurationMs: number;
  successRate: number;
  lastFailureReason: string | null;
  rateLimitedUntil: number | null;
  isRateLimited: boolean;
  isAvailable: boolean;
  currentTaskId: string | null;
  currentTaskStartMs: number | null;
};

export type AgentRegistrySnapshot = {
  timestamp: string;
  agents: AgentStats[];
};

type InternalAgentState = {
  metadata: AgentMetadata;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  totalDurationMs: number;
  lastFailureReason: string | null;
  rateLimitedUntil: number | null;
  currentTaskId: string | null;
  currentTaskStartMs: number | null;
};

function computeStats(state: InternalAgentState): AgentStats {
  const total = state.successCount + state.failureCount;
  const now = Date.now();
  const isRateLimited =
    state.rateLimitedUntil !== null && state.rateLimitedUntil > now;

  return {
    ...state.metadata,
    successCount: state.successCount,
    failureCount: state.failureCount,
    rateLimitCount: state.rateLimitCount,
    avgDurationMs: total > 0 ? state.totalDurationMs / total : 0,
    successRate: total > 0 ? state.successCount / total : 0,
    lastFailureReason: state.lastFailureReason,
    rateLimitedUntil: state.rateLimitedUntil,
    isRateLimited,
    isAvailable: !isRateLimited && state.currentTaskId === null,
    currentTaskId: state.currentTaskId,
    currentTaskStartMs: state.currentTaskStartMs,
  };
}

export class AgentRegistry {
  private agents = new Map<string, InternalAgentState>();

  registerAgent(id: string, metadata: AgentMetadata): void {
    this.agents.set(id, {
      metadata: { ...metadata, id },
      successCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
      totalDurationMs: 0,
      lastFailureReason: null,
      rateLimitedUntil: null,
      currentTaskId: null,
      currentTaskStartMs: null,
    });
  }

  recordSuccess(agentId: string, _taskId: string, durationMs: number): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.successCount++;
    state.totalDurationMs += durationMs;
    state.currentTaskId = null;
    state.currentTaskStartMs = null;
  }

  recordFailure(
    agentId: string,
    _taskId: string,
    reason: string,
    durationMs: number,
  ): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.failureCount++;
    state.totalDurationMs += durationMs;
    state.lastFailureReason = reason;
    state.currentTaskId = null;
    state.currentTaskStartMs = null;
  }

  recordRateLimit(agentId: string, retryAfterMs?: number): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.rateLimitCount++;
    state.lastFailureReason = "Rate limited";
    if (retryAfterMs !== undefined) {
      state.rateLimitedUntil = Date.now() + retryAfterMs;
    }
    state.currentTaskId = null;
    state.currentTaskStartMs = null;
  }

  assignTask(agentId: string, taskId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.currentTaskId = taskId;
    state.currentTaskStartMs = Date.now();
  }

  releaseAgent(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.currentTaskId = null;
    state.currentTaskStartMs = null;
  }

  getAvailableAgents(): AgentStats[] {
    return Array.from(this.agents.values())
      .map(computeStats)
      .filter((s) => s.isAvailable);
  }

  getAgentStats(): AgentStats[] {
    return Array.from(this.agents.values()).map(computeStats);
  }

  getAgentStatsById(id: string): AgentStats | undefined {
    const state = this.agents.get(id);
    return state ? computeStats(state) : undefined;
  }

  getSnapshot(): AgentRegistrySnapshot {
    return {
      timestamp: new Date().toISOString(),
      agents: this.getAgentStats(),
    };
  }

  toPromptContext(): string {
    const now = new Date();
    const stats = this.getAgentStats();

    const header = `## Agent Pool Status (as of ${now.toISOString()})`;

    const tableHeader = [
      "| Agent | Type | Success Rate | Avg Duration | Status | Current Task |",
      "|-------|------|-------------|-------------|--------|-------------|",
    ].join("\n");

    const rows = stats.map((s) => {
      const total = s.successCount + s.failureCount;
      const rateStr =
        total > 0
          ? `${Math.round(s.successRate * 100)}% (${s.successCount}/${total})`
          : "N/A";
      const avgStr =
        total > 0 ? `${(s.avgDurationMs / 60_000).toFixed(1)}m` : "-";

      let status: string;
      if (s.currentTaskId) {
        status = "🔄 busy";
      } else if (s.isRateLimited && s.rateLimitedUntil) {
        const until = new Date(s.rateLimitedUntil);
        const timeStr = `${String(until.getUTCHours()).padStart(2, "0")}:${String(until.getUTCMinutes()).padStart(2, "0")}`;
        status = `⏳ rate-limited until ${timeStr}`;
      } else {
        status = "✅ available";
      }

      const task = s.currentTaskId ?? "-";

      return `| ${s.id} | ${s.type} | ${rateStr} | ${avgStr} | ${status} | ${task} |`;
    });

    const failedAgents = stats.filter((s) => s.lastFailureReason);
    let failureSection = "";
    if (failedAgents.length > 0) {
      failureSection =
        "\n\nRecent failures:\n" +
        failedAgents
          .map((s) => `- ${s.id}: "${s.lastFailureReason}"`)
          .join("\n");
    }

    return [header, "", tableHeader, ...rows, failureSection].join("\n");
  }
}

let instance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!instance) {
    instance = new AgentRegistry();
  }
  return instance;
}

export function resetAgentRegistry(): void {
  instance = null;
}

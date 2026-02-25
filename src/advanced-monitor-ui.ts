/**
 * Standalone OpenTUI Monitor UI logic.
 *
 * Four-panel dashboard:
 *  - Top: Phase indicator + global stats bar
 *  - Left: Pipeline kanban (per-ticket stage progress)
 *  - Right: Active jobs / ticket detail / event log / captured logs
 *
 * Shared between:
 *  - The Smithers <Monitor> component (in-workflow)
 *  - The standalone CLI launcher (for --resume)
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// --- Constants ---

const DISPLAY_STAGES = [
  { key: "research",     abbr: "R", table: "research",     nodeId: "research" },
  { key: "plan",         abbr: "P", table: "plan",         nodeId: "plan" },
  { key: "implement",    abbr: "I", table: "implement",    nodeId: "implement" },
  { key: "test",         abbr: "T", table: "test_results", nodeId: "test" },
  { key: "build-verify", abbr: "B", table: "build_verify", nodeId: "build-verify" },
  { key: "spec-review",  abbr: "S", table: "spec_review",  nodeId: "spec-review" },
  { key: "code-review",  abbr: "V", table: "code_review",  nodeId: "code-review" },
  { key: "review-fix",   abbr: "F", table: "review_fix",   nodeId: "review-fix" },
  { key: "report",       abbr: "G", table: "report",       nodeId: "report" },
] as const;

const TIER_STAGES: Record<string, readonly string[]> = {
  trivial: ["implement", "build-verify"],
  small:   ["implement", "test", "build-verify"],
  medium:  ["research", "plan", "implement", "test", "build-verify", "code-review"],
  large:   ["research", "plan", "implement", "test", "build-verify", "spec-review", "code-review", "review-fix", "report"],
};

const PRIORITY_ABBR: Record<string, string> = { critical: "!!", high: "hi", medium: "md", low: "lo" };
const TIER_ABBR: Record<string, string> = { trivial: "trv", small: "sml", medium: "med", large: "lrg" };
const JOB_ABBR: Record<string, string> = {
  "discovery": "discover", "progress-update": "progress",
  "ticket:research": "research", "ticket:plan": "plan", "ticket:implement": "impl",
  "ticket:test": "test", "ticket:build-verify": "build", "ticket:spec-review": "spec-rev",
  "ticket:code-review": "code-rev", "ticket:review-fix": "rev-fix", "ticket:report": "report",
};

// Stage detail: which column to SELECT for human-readable summary
const STAGE_SUMMARY_COL: Record<string, string> = {
  research: "summary", plan: "plan_file_path", implement: "what_was_done",
  test_results: "failing_summary", build_verify: "build_passed",
  spec_review: "severity", code_review: "severity",
  review_fix: "summary", report: "summary",
};

// --- Workflow Phases ---

type WorkflowPhase =
  | "starting"         // Before anything has run
  | "interpreting"     // InterpretConfig running
  | "discovering"      // Discovery job active, no tickets yet
  | "pipeline"         // Tickets being processed through stages
  | "merging"          // Merge queue actively landing tickets
  | "done";            // All tickets landed

const PHASE_DISPLAY: Record<WorkflowPhase, { label: string; icon: string }> = {
  starting:     { label: "Starting",          icon: "\u23F3" },  // ⏳
  interpreting: { label: "Interpreting Config", icon: "\u2699" }, // ⚙
  discovering:  { label: "Discovering Tickets", icon: "\uD83D\uDD0D" }, // 🔍
  pipeline:     { label: "Pipeline Active",    icon: "\u25B6" },  // ▶
  merging:      { label: "Merge Queue",        icon: "\uD83D\uDD00" }, // 🔀
  done:         { label: "Complete",           icon: "\u2705" },  // ✅
};

// --- Types ---

type StageStatus = "completed" | "running" | "pending" | "failed";

interface StageView { abbr: string; key: string; status: StageStatus }

interface TicketView {
  id: string;
  title: string;
  tier: string;
  priority: string;
  stages: StageView[];
  landStatus: "landed" | "evicted" | null;
}

interface ActiveJob {
  jobType: string;
  agentId: string;
  ticketId: string | null;
  elapsedMs: number;
}

interface MergeQueueActivity {
  ticketsLanded: Array<{ ticketId: string; summary: string }>;
  ticketsEvicted: Array<{ ticketId: string; reason: string }>;
  ticketsSkipped: Array<{ ticketId: string; reason: string }>;
  summary: string | null;
}

interface PollData {
  tickets: TicketView[];
  activeJobs: ActiveJob[];
  discovered: number;
  landed: number;
  evicted: number;
  inPipeline: number;
  maxConcurrency: number;
  phase: WorkflowPhase;
  mergeQueueActivity: MergeQueueActivity | null;
  schedulerReasoning: string | null;
  discoveryCount: number;  // How many discovery rounds have completed
}

interface TicketDetail {
  id: string;
  title: string;
  tier: string;
  priority: string;
  stages: Array<{ abbr: string; key: string; status: string; summary: string }>;
  landSummary?: string;
}

interface EventLogEntry {
  time: string;
  message: string;
}

// --- Ring Buffer for captured logs ---

class RingBuffer {
  private buf: string[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(line: string) {
    this.buf.push(line);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  getAll(): string[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }
}

// --- Helpers ---

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 2) + ".." : s;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fmtTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function stageIcon(s: StageStatus): string {
  switch (s) {
    case "completed": return "\x1b[32m\u2713\x1b[0m";  // green ✓
    case "running":   return "\x1b[36m\u25D0\x1b[0m";  // cyan ◐
    case "failed":    return "\x1b[31m\u2717\x1b[0m";  // red ✗
    default:          return "\x1b[90m\u00B7\x1b[0m";  // gray ·
  }
}

// Plain (no ANSI) version for width calculations
function stageIconPlain(s: StageStatus): string {
  switch (s) {
    case "completed": return "\u2713";
    case "running":   return "\u25D0";
    case "failed":    return "\u2717";
    default:          return "\u00B7";
  }
}

// --- Exports ---

export interface MonitorUIOptions {
  dbPath: string;
  runId: string;
  projectName: string;
  prompt: string;
  logFile?: string;  // Path to write captured stdout/stderr
}

export async function runMonitorUI(opts: MonitorUIOptions): Promise<{ started: boolean; status: string }> {
  const { dbPath, runId, projectName, prompt } = opts;

  const ot = await import("@opentui/core");
  const { createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable } = ot;
  const RGBA = ot.RGBA;
  const { Database } = await import("bun:sqlite");

  const scheduledDbPath = join(dirname(dbPath), "..", "scheduled-tasks.db");

  // ── Console capture ──
  // Redirect stdout/stderr to a ring buffer + optional log file so they don't
  // corrupt the alternate screen. Restore on exit.
  const capturedLogs = new RingBuffer(200);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let logFileHandle: any = null;

  const logFilePath = opts.logFile || join(dirname(dbPath), "..", "monitor.log");
  try {
    logFileHandle = Bun.file(logFilePath).writer();
  } catch {
    // Can't open log file — captured logs still go to ring buffer
  }

  function captureWrite(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    // Split on newlines, skip empty
    for (const line of text.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed) capturedLogs.push(`${fmtTime()} ${trimmed}`);
    }
    if (logFileHandle) {
      try { logFileHandle.write(text); } catch {}
    }
    return true;
  }

  // Install capture — any console.log/error from Smithers or agents goes here
  process.stdout.write = captureWrite as any;
  process.stderr.write = captureWrite as any;

  function restoreConsole() {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (logFileHandle) {
      try { logFileHandle.flush(); logFileHandle.end(); } catch {}
    }
  }

  const renderer = await createCliRenderer({
    useAlternateScreen: true,
    useMouse: false,
    exitOnCtrlC: false,
  });

  // ── State ──
  let data: PollData = {
    tickets: [], activeJobs: [], discovered: 0, landed: 0, evicted: 0,
    inPipeline: 0, maxConcurrency: 0, phase: "starting",
    mergeQueueActivity: null, schedulerReasoning: null, discoveryCount: 0,
  };
  let selectedIdx = 0;
  let focus: "pipeline" | "jobs" | "detail" | "events" | "logs" = "pipeline";
  let detail: TicketDetail | null = null;
  let isRunning = true;
  let lastError: string | null = null;  // Surface DB errors instead of swallowing
  const eventLog: EventLogEntry[] = [];
  let prevPhase: WorkflowPhase = "starting";

  function addEvent(message: string) {
    eventLog.push({ time: fmtTime(), message });
    // Keep last 100 events
    if (eventLog.length > 100) eventLog.shift();
  }

  addEvent("Monitor started");

  // ── Colors ──
  const c = {
    border:   RGBA.fromInts(75, 85, 99),
    selected: RGBA.fromInts(6, 182, 212),
    phase:    RGBA.fromInts(168, 85, 247),
  };

  // ── Layout ──
  const root = new BoxRenderable(renderer, {
    id: "root", border: true, title: ` Super Ralph: ${projectName} `,
    width: "100%", height: "100%", flexDirection: "column",
  });
  renderer.root.add(root);

  // Phase + header
  const phaseText = new TextRenderable(renderer, {
    id: "phase", height: 1,
    content: `${PHASE_DISPLAY.starting.icon} ${PHASE_DISPLAY.starting.label}`,
  });
  root.add(phaseText);

  const header = new TextRenderable(renderer, {
    id: "header", height: 1,
    content: `Run: ${runId.slice(0, 20)}... | ${truncate(prompt, 50)}`,
  });
  root.add(header);

  const statsText = new TextRenderable(renderer, { id: "stats", height: 1, content: "Loading..." });
  root.add(statsText);

  const content = new BoxRenderable(renderer, {
    id: "content", border: false, flexDirection: "row", flexGrow: 1, gap: 1,
  });
  root.add(content);

  // Left: Pipeline
  const pipeBox = new BoxRenderable(renderer, {
    id: "pipeBox", border: true, title: " Pipeline ", width: "60%",
    flexDirection: "column", borderColor: c.selected,
  });
  content.add(pipeBox);

  const pipeScroll = new ScrollBoxRenderable(renderer, { id: "pipeScroll", flexGrow: 1, scrollY: true });
  pipeBox.add(pipeScroll);

  const pipeText = new TextRenderable(renderer, { id: "pipeText", content: "Waiting for discovery..." });
  pipeScroll.add(pipeText);

  // Right: Jobs / Detail / Events / Logs
  const rightBox = new BoxRenderable(renderer, {
    id: "rightBox", border: true, title: " Active Jobs ", flexGrow: 1,
    flexDirection: "column", borderColor: c.border,
  });
  content.add(rightBox);

  const rightScroll = new ScrollBoxRenderable(renderer, { id: "rightScroll", flexGrow: 1, scrollY: true });
  rightBox.add(rightScroll);

  const rightText = new TextRenderable(renderer, { id: "rightText", content: "No active jobs" });
  rightScroll.add(rightText);

  const footer = new TextRenderable(renderer, {
    id: "footer", height: 1,
    content: "\u2191\u2193:Nav | Enter:Details | Tab:Switch | E:Events | L:Logs | Esc:Back | Q:Quit",
  });
  root.add(footer);

  // ── Update display ──
  function update() {
    pipeBox.borderColor = focus === "pipeline" ? c.selected : c.border;
    rightBox.borderColor = focus !== "pipeline" ? c.selected : c.border;

    // Phase indicator
    const phaseInfo = PHASE_DISPLAY[data.phase];
    let phaseExtra = "";
    if (data.phase === "discovering") {
      phaseExtra = data.discoveryCount > 0
        ? ` (round ${data.discoveryCount + 1}, ${data.discovered} tickets found so far)`
        : " (initial discovery...)";
    } else if (data.phase === "merging") {
      const mq = data.mergeQueueActivity;
      if (mq) {
        const parts: string[] = [];
        if (mq.ticketsLanded.length > 0) parts.push(`${mq.ticketsLanded.length} landed`);
        if (mq.ticketsEvicted.length > 0) parts.push(`${mq.ticketsEvicted.length} evicted`);
        if (parts.length > 0) phaseExtra = ` (${parts.join(", ")})`;
      }
    } else if (data.phase === "pipeline") {
      const active = data.inPipeline - data.landed;
      phaseExtra = ` (${active} in flight, ${data.landed} landed)`;
    }
    phaseText.content = `${phaseInfo.icon} ${phaseInfo.label}${phaseExtra}`;

    // Stats bar
    const { discovered, landed, evicted, inPipeline, activeJobs, maxConcurrency } = data;
    const slots = maxConcurrency ? `${activeJobs.length}/${maxConcurrency}` : `${activeJobs.length}`;
    const errorIndicator = lastError ? ` | \x1b[31mERR\x1b[0m` : "";
    statsText.content = `Discovered: ${discovered} | In Pipeline: ${inPipeline} | Landed: ${landed} | Evicted: ${evicted} | Jobs: ${slots}${errorIndicator}`;

    // Pipeline panel — varies by phase
    if (data.phase === "starting" || data.phase === "interpreting") {
      const lines = [
        data.phase === "starting"
          ? "Workflow starting up..."
          : "AI is interpreting your prompt and configuring the pipeline...",
        "",
        "This usually takes 1-2 minutes.",
        "",
        "The AI reads your prompt, clarification answers, and the",
        "repository structure to configure: project name, focus areas,",
        "build/test commands, code style, and review checklist.",
      ];
      pipeText.content = lines.join("\n");
    } else if (data.phase === "discovering" && data.tickets.length === 0) {
      const lines = [
        "Discovering tickets from specs and codebase...",
        "",
        `Discovery rounds completed: ${data.discoveryCount}`,
        "",
        "The agent reads your specs, browses the codebase,",
        "and generates tickets with complexity tiers.",
      ];
      if (data.activeJobs.length > 0) {
        const discoverJob = data.activeJobs.find(j => j.jobType === "discovery");
        if (discoverJob) {
          lines.push("", `Running for ${fmtElapsed(discoverJob.elapsedMs)} on ${discoverJob.agentId}`);
        }
      }
      pipeText.content = lines.join("\n");
    } else if (data.tickets.length === 0) {
      pipeText.content = "Waiting for discovery...";
    } else {
      const lines = data.tickets.map((t, i) => {
        const sel = (i === selectedIdx && focus === "pipeline") ? "> " : "  ";
        const name = truncate(t.title || t.id, 20).padEnd(20);
        const stages = t.stages.map(s => stageIcon(s.status)).join("");
        const tier = (TIER_ABBR[t.tier] || t.tier.slice(0, 3)).padEnd(3);
        const pri = PRIORITY_ABBR[t.priority] || t.priority.slice(0, 2);
        const land = t.landStatus === "landed" ? " \x1b[32m\u2714\x1b[0m" : t.landStatus === "evicted" ? " \x1b[31m\u2718\x1b[0m" : "";
        return `${sel}${name} [${stages}] ${tier} ${pri}${land}`;
      });
      pipeText.content = lines.join("\n");
    }

    // Right panel
    if (focus === "detail" && detail) {
      rightBox.title = ` ${detail.id} `;
      const lines = [
        detail.title,
        `${detail.tier} | ${detail.priority}`,
        "",
        ...detail.stages.map(s => {
          const icon = stageIcon(s.status as StageStatus);
          const summary = s.summary ? `: ${s.summary}` : "";
          return `${s.abbr} ${icon} ${s.status}${truncate(summary, 40)}`;
        }),
      ];
      if (detail.landSummary) {
        lines.push("", "Land:", detail.landSummary);
      }
      rightText.content = lines.join("\n");
    } else if (focus === "events") {
      rightBox.title = ` Event Log (${eventLog.length}) `;
      if (eventLog.length === 0) {
        rightText.content = "No events yet";
      } else {
        // Show most recent events first
        const recent = eventLog.slice(-30).reverse();
        rightText.content = recent.map(e => `${e.time} ${e.message}`).join("\n");
      }
    } else if (focus === "logs") {
      rightBox.title = ` Captured Logs (${capturedLogs.length}) `;
      const lines = capturedLogs.getAll();
      if (lines.length === 0) {
        rightText.content = "No captured output";
      } else {
        // Show most recent 40 lines
        rightText.content = lines.slice(-40).join("\n");
      }
    } else {
      // Jobs panel (default for focus === "jobs" or "pipeline")
      rightBox.title = ` Active Jobs (${data.activeJobs.length}) `;
      if (data.activeJobs.length === 0) {
        // Show context-aware empty state
        if (data.phase === "starting" || data.phase === "interpreting") {
          rightText.content = "Waiting for pipeline to start...";
        } else if (data.phase === "done") {
          rightText.content = "\x1b[32mAll work complete!\x1b[0m";
        } else {
          rightText.content = "No active jobs — scheduler will fill slots shortly";
        }
      } else {
        const lines = data.activeJobs.map(j => {
          const type = JOB_ABBR[j.jobType] || j.jobType.replace("ticket:", "");
          const label = j.ticketId ? `${j.ticketId}:${type}` : type;
          const icon = j.jobType === "discovery" ? "\uD83D\uDD0D"
                     : j.jobType.startsWith("ticket:") ? "\u25D0"
                     : "\u2699";
          return `${icon} ${truncate(label, 20).padEnd(20)} ${truncate(j.agentId, 10).padEnd(10)} ${fmtElapsed(j.elapsedMs)}`;
        });

        // If merge queue is active, append merge info
        if (data.mergeQueueActivity) {
          const mq = data.mergeQueueActivity;
          lines.push("");
          lines.push("\x1b[1mMerge Queue:\x1b[0m");
          for (const t of mq.ticketsLanded) {
            lines.push(`  \x1b[32m\u2714\x1b[0m ${t.ticketId}: ${truncate(t.summary, 40)}`);
          }
          for (const t of mq.ticketsEvicted) {
            lines.push(`  \x1b[31m\u2718\x1b[0m ${t.ticketId}: ${truncate(t.reason, 40)}`);
          }
          for (const t of mq.ticketsSkipped) {
            lines.push(`  \x1b[90m\u2014\x1b[0m ${t.ticketId}: ${truncate(t.reason, 40)}`);
          }
          if (mq.summary) {
            lines.push(`  ${truncate(mq.summary, 50)}`);
          }
        }

        rightText.content = lines.join("\n");
      }
    }

    renderer.requestRender();
  }

  // ── Fetch ticket detail (on-demand) ──
  async function fetchDetail(ticketId: string) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const ticket = data.tickets.find(t => t.id === ticketId);
      if (!ticket) { db.close(); return; }

      const tierStages = TIER_STAGES[ticket.tier] || TIER_STAGES.medium;
      const stages: TicketDetail["stages"] = [];

      for (const sd of DISPLAY_STAGES) {
        if (!tierStages.includes(sd.key)) continue;
        const stageView = ticket.stages.find(s => s.key === sd.key);
        let summary = "";
        if (stageView?.status === "completed" || stageView?.status === "failed") {
          const col = STAGE_SUMMARY_COL[sd.table] || "summary";
          try {
            const row = db.query(`SELECT ${col} FROM ${sd.table} WHERE run_id = ? AND node_id = ? ORDER BY iteration DESC LIMIT 1`)
              .get(runId, `${ticketId}:${sd.nodeId}`) as any;
            if (row) summary = String(row[col] ?? "");
          } catch (err) {
            summary = `(query failed: ${err instanceof Error ? err.message : "unknown"})`;
          }
        }
        stages.push({ abbr: sd.abbr, key: sd.key, status: stageView?.status || "pending", summary });
      }

      let landSummary: string | undefined;
      try {
        const row = db.query(`SELECT summary FROM land WHERE run_id = ? AND node_id = ? ORDER BY iteration DESC LIMIT 1`)
          .get(runId, `${ticketId}:land`) as any;
        if (row) landSummary = row.summary;
      } catch {
        // land table may not exist yet
      }

      // Also check merge_queue_result for land info
      if (!landSummary) {
        try {
          const rows = db.query(`SELECT tickets_landed, tickets_evicted FROM merge_queue_result WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`)
            .all(runId) as any[];
          for (const row of rows) {
            const landed = JSON.parse(row.tickets_landed || "[]");
            const evicted = JSON.parse(row.tickets_evicted || "[]");
            const landedEntry = landed.find((t: any) => t.ticketId === ticketId);
            const evictedEntry = evicted.find((t: any) => t.ticketId === ticketId);
            if (landedEntry) landSummary = `Landed: ${landedEntry.summary}`;
            if (evictedEntry) landSummary = `Evicted: ${evictedEntry.reason} — ${evictedEntry.details}`;
          }
        } catch {
          // merge_queue_result table may not exist yet
        }
      }

      db.close();
      detail = { id: ticket.id, title: ticket.title, tier: ticket.tier, priority: ticket.priority, stages, landSummary };
    } catch (err) {
      lastError = `Detail fetch failed: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }

  // ── Phase detection ──
  function detectPhase(
    hasInterpretConfig: boolean,
    tickets: TicketView[],
    activeJobs: ActiveJob[],
    landed: number,
    mergeQueueActive: boolean,
  ): WorkflowPhase {
    // All tickets landed and no active jobs
    if (tickets.length > 0 && landed === tickets.length && activeJobs.length === 0) {
      return "done";
    }

    // Merge queue is actively running
    if (mergeQueueActive) {
      return "merging";
    }

    // InterpretConfig hasn't completed
    if (!hasInterpretConfig) {
      return "interpreting";
    }

    // Have tickets in the pipeline
    if (tickets.length > 0 && tickets.some(t => t.landStatus !== "landed")) {
      return "pipeline";
    }

    // No tickets yet but discovery job is running
    if (activeJobs.some(j => j.jobType === "discovery")) {
      return "discovering";
    }

    // InterpretConfig done but no tickets and no discovery — brief transitional state
    if (tickets.length === 0) {
      return "discovering";
    }

    return "pipeline";
  }

  // ── Poll database ──
  async function poll() {
    const now = Date.now();
    lastError = null;

    // Check if DB file exists yet
    if (!existsSync(dbPath)) {
      data = { ...data, phase: "starting" };
      return;
    }

    try {
      const db = new Database(dbPath, { readonly: true });

      // 1. Check if InterpretConfig has completed
      let hasInterpretConfig = false;
      try {
        const row = db.query(`SELECT 1 FROM interpret_config WHERE run_id = ? LIMIT 1`).get(runId) as any;
        hasInterpretConfig = !!row;
      } catch {
        // Table may not exist yet — that's fine, means InterpretConfig hasn't run
      }

      // 2. All discovered tickets (process in iteration order so later discoveries override)
      const ticketMap = new Map<string, { id: string; title: string; tier: string; priority: string }>();
      let discoveryCount = 0;
      try {
        const rows = db.query(`SELECT tickets FROM discover WHERE run_id = ? ORDER BY iteration ASC`).all(runId) as any[];
        discoveryCount = rows.length;
        for (const row of rows) {
          try {
            const arr = JSON.parse(row.tickets);
            if (!Array.isArray(arr)) continue;
            for (const t of arr) {
              if (t?.id) {
                ticketMap.set(t.id, {
                  id: t.id,
                  title: t.title || t.id,
                  tier: t.complexityTier || t.complexity_tier || "medium",
                  priority: t.priority || "medium",
                });
              }
            }
          } catch {
            // Malformed JSON in a discovery row — skip it
          }
        }
      } catch {
        // discover table doesn't exist yet
      }

      // 3. Node states from Smithers (one query for all)
      const nodeState = new Map<string, string>(); // node_id -> state
      try {
        const rows = db.query(
          `SELECT node_id, state FROM _smithers_nodes WHERE run_id = ? ORDER BY iteration ASC`
        ).all(runId) as any[];
        for (const r of rows) nodeState.set(r.node_id, r.state);
      } catch {
        // _smithers_nodes table may not exist yet
      }

      // 4. Active jobs from scheduled-tasks DB
      let activeJobs: ActiveJob[] = [];
      try {
        if (existsSync(scheduledDbPath)) {
          const stDb = new Database(scheduledDbPath, { readonly: true });
          const rows = stDb.query(
            `SELECT job_type, agent_id, ticket_id, created_at_ms FROM scheduled_tasks ORDER BY created_at_ms ASC`
          ).all() as any[];
          activeJobs = rows.map(r => ({
            jobType: r.job_type,
            agentId: r.agent_id,
            ticketId: r.ticket_id,
            elapsedMs: now - (r.created_at_ms || now),
          }));
          stDb.close();
        }
      } catch (err) {
        lastError = `scheduled-tasks.db: ${err instanceof Error ? err.message : "unknown"}`;
      }

      // 5. Land status (latest iteration per ticket wins)
      const landMap = new Map<string, "landed" | "evicted">();
      try {
        const rows = db.query(`SELECT node_id, merged, evicted FROM land WHERE run_id = ? ORDER BY iteration DESC`).all(runId) as any[];
        for (const r of rows) {
          const tid = r.node_id.replace(/:land$/, "");
          if (!landMap.has(tid)) {
            if (r.merged) landMap.set(tid, "landed");
            else if (r.evicted) landMap.set(tid, "evicted");
          }
        }
      } catch {
        // land table may not exist yet
      }

      // 6. Also check merge_queue_result for landed/evicted tickets
      let mergeQueueActivity: MergeQueueActivity | null = null;
      let mergeQueueNodeActive = false;
      try {
        // Check if merge queue node is currently running
        const mqState = nodeState.get("agentic-merge-queue");
        mergeQueueNodeActive = mqState === "in-progress";

        const rows = db.query(`SELECT tickets_landed, tickets_evicted, tickets_skipped, summary FROM merge_queue_result WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`).all(runId) as any[];
        if (rows.length > 0) {
          const row = rows[0];
          const landed = JSON.parse(row.tickets_landed || "[]");
          const evicted = JSON.parse(row.tickets_evicted || "[]");
          const skipped = JSON.parse(row.tickets_skipped || "[]");

          mergeQueueActivity = {
            ticketsLanded: landed,
            ticketsEvicted: evicted,
            ticketsSkipped: skipped,
            summary: row.summary || null,
          };

          // Also update landMap from merge queue results
          for (const t of landed) {
            if (t.ticketId && !landMap.has(t.ticketId)) {
              landMap.set(t.ticketId, "landed");
            }
          }
          for (const t of evicted) {
            if (t.ticketId && !landMap.has(t.ticketId)) {
              landMap.set(t.ticketId, "evicted");
            }
          }
        }
      } catch {
        // merge_queue_result table may not exist yet
      }

      // 7. Max concurrency (latest iteration)
      let maxConcurrency = 0;
      try {
        const row = db.query(`SELECT max_concurrency FROM interpret_config WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`).get(runId) as any;
        if (row) maxConcurrency = row.max_concurrency || 0;
      } catch {
        // interpret_config table may not exist yet
      }

      // 8. Scheduler reasoning (latest)
      let schedulerReasoning: string | null = null;
      try {
        const row = db.query(`SELECT reasoning FROM ticket_schedule WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`).get(runId) as any;
        if (row) schedulerReasoning = row.reasoning;
      } catch {
        // ticket_schedule table may not exist yet
      }

      db.close();

      // Build ticket views
      const tickets: TicketView[] = [];
      ticketMap.forEach((t) => {
        const tierStages = TIER_STAGES[t.tier] || TIER_STAGES.medium;
        const stages: StageView[] = [];

        for (const sd of DISPLAY_STAGES) {
          if (!tierStages.includes(sd.key)) continue;
          const nid = `${t.id}:${sd.nodeId}`;
          const st = nodeState.get(nid);
          let status: StageStatus = "pending";
          if (st === "completed") status = "completed";
          else if (st === "failed") status = "failed";
          else if (st === "in-progress") status = "running";
          stages.push({ abbr: sd.abbr, key: sd.key, status });
        }

        tickets.push({
          id: t.id, title: t.title, tier: t.tier, priority: t.priority,
          stages,
          landStatus: landMap.get(t.id) || null,
        });
      });

      // Sort: running first, then landed last, then by priority
      const priOrd: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      tickets.sort((a, b) => {
        const aRun = a.stages.some(s => s.status === "running") ? 0 : 1;
        const bRun = b.stages.some(s => s.status === "running") ? 0 : 1;
        if (aRun !== bRun) return aRun - bRun;
        const aLand = a.landStatus === "landed" ? 1 : 0;
        const bLand = b.landStatus === "landed" ? 1 : 0;
        if (aLand !== bLand) return aLand - bLand;
        return (priOrd[a.priority] ?? 3) - (priOrd[b.priority] ?? 3);
      });

      const landed = tickets.filter(t => t.landStatus === "landed").length;
      const evicted = tickets.filter(t => t.landStatus === "evicted").length;

      // Detect workflow phase
      const phase = detectPhase(
        hasInterpretConfig, tickets, activeJobs, landed,
        mergeQueueNodeActive,
      );

      // Log phase transitions
      if (phase !== prevPhase) {
        const phaseLabel = PHASE_DISPLAY[phase].label;
        addEvent(`Phase: ${phaseLabel}`);
        if (phase === "discovering" && prevPhase === "interpreting") {
          addEvent("Config interpreted — starting ticket discovery");
        } else if (phase === "pipeline" && prevPhase === "discovering") {
          addEvent(`Tickets discovered (${tickets.length}) — pipeline starting`);
        } else if (phase === "merging") {
          addEvent("Merge queue activated — landing completed tickets");
        } else if (phase === "done") {
          addEvent(`All ${tickets.length} tickets landed — workflow complete`);
        }
        prevPhase = phase;
      }

      // Log notable changes
      if (data.landed < landed) {
        const newlyLanded = landed - data.landed;
        addEvent(`${newlyLanded} ticket(s) landed (total: ${landed}/${tickets.length})`);
      }
      if (data.evicted < evicted) {
        const newlyEvicted = evicted - data.evicted;
        addEvent(`${newlyEvicted} ticket(s) evicted`);
      }
      if (data.discovered < tickets.length) {
        const newTickets = tickets.length - data.discovered;
        addEvent(`${newTickets} new ticket(s) discovered (total: ${tickets.length})`);
      }

      data = {
        tickets, activeJobs,
        discovered: tickets.length, landed, evicted,
        inPipeline: tickets.length - landed,
        maxConcurrency,
        phase, mergeQueueActivity, schedulerReasoning, discoveryCount,
      };

      if (selectedIdx >= data.tickets.length) {
        selectedIdx = Math.max(0, data.tickets.length - 1);
      }
    } catch (err) {
      lastError = `Poll failed: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }

  // ── Shutdown ──
  function shutdown() {
    isRunning = false;
    restoreConsole();
    renderer.destroy();
  }

  // ── Input handler ──
  renderer.prependInputHandler((seq: string) => {
    if (!isRunning) return false;

    // Ctrl+C or Q/q — exit
    if (seq === "\x03" || seq === "q" || seq === "Q") {
      shutdown();
      return true;
    }

    // Tab — cycle through focus modes
    if (seq === "\t") {
      const modes: typeof focus[] = ["pipeline", "jobs", "events", "logs"];
      const idx = modes.indexOf(focus === "detail" ? "pipeline" : focus);
      focus = modes[(idx + 1) % modes.length];
      detail = null;
      update();
      return true;
    }

    // E — jump to events
    if (seq === "e" || seq === "E") {
      focus = "events";
      detail = null;
      update();
      return true;
    }

    // L — jump to logs
    if (seq === "l" || seq === "L") {
      focus = "logs";
      detail = null;
      update();
      return true;
    }

    // Esc — back to pipeline
    if (seq === "\x1b" && (focus === "detail" || focus === "events" || focus === "logs")) {
      focus = "pipeline";
      detail = null;
      update();
      return true;
    }

    // Pipeline navigation
    if (focus === "pipeline") {
      if (seq === "\x1b[A") { selectedIdx = Math.max(0, selectedIdx - 1); update(); return true; }
      if (seq === "\x1b[B") { selectedIdx = Math.min(data.tickets.length - 1, selectedIdx + 1); update(); return true; }
      if (seq === "\r" || seq === "\n") {
        const t = data.tickets[selectedIdx];
        if (t) {
          focus = "detail";
          fetchDetail(t.id).then(update);
        }
        return true;
      }
    }

    // Scrolling in right panels
    if (focus === "jobs" || focus === "detail" || focus === "events" || focus === "logs") {
      if (seq === "\x1b[A") { rightScroll.scrollBy(-3, "step"); return true; }
      if (seq === "\x1b[B") { rightScroll.scrollBy(3, "step"); return true; }
    }

    return false;
  });

  // ── Main loop ──
  await poll();
  update();
  renderer.start();

  // Adaptive polling: faster when jobs are active, slower when idle
  while (isRunning) {
    const interval = data.activeJobs.length > 0 ? 1500 : 3000;
    await new Promise(r => setTimeout(r, interval));
    if (!isRunning) break;
    await poll();
    update();
  }

  restoreConsole();
  return { started: true, status: "stopped" };
}

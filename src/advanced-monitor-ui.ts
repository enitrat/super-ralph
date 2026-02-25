/**
 * Standalone OpenTUI Monitor UI logic.
 *
 * Layout:
 *  - Top: Phase indicator + global stats bar
 *  - Left: Pipeline kanban (per-ticket stage progress)
 *  - Right: 3 stacked panels — Active Jobs | Event Log | Captured Logs
 *    Tab cycles focus between panels for scrolling.
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
  discoveryCount: number;
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

// --- Exports ---

export interface MonitorUIOptions {
  dbPath: string;
  runId: string;
  projectName: string;
  prompt: string;
  logFile?: string;
}

export async function runMonitorUI(opts: MonitorUIOptions): Promise<{ started: boolean; status: string }> {
  const { dbPath, runId, projectName, prompt } = opts;

  const ot = await import("@opentui/core");
  const { createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable } = ot;
  const RGBA = ot.RGBA;
  const { Database } = await import("bun:sqlite");

  const scheduledDbPath = join(dirname(dbPath), "..", "scheduled-tasks.db");

  // ── Console capture ──
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
    for (const line of text.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed) capturedLogs.push(`${fmtTime()} ${trimmed}`);
    }
    if (logFileHandle) {
      try { logFileHandle.write(text); } catch {}
    }
    return true;
  }

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
  // focus: pipeline = left panel; jobs/events/logs = right panels
  let focus: "pipeline" | "jobs" | "events" | "logs" = "pipeline";
  let detail: TicketDetail | null = null;
  let isRunning = true;
  let lastError: string | null = null;
  const eventLog: EventLogEntry[] = [];
  let prevPhase: WorkflowPhase = "starting";

  function addEvent(message: string) {
    eventLog.push({ time: fmtTime(), message });
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

  // ── Left: Pipeline ──
  const pipeBox = new BoxRenderable(renderer, {
    id: "pipeBox", border: true, title: " Pipeline ", width: "55%",
    flexDirection: "column", borderColor: c.selected,
  });
  content.add(pipeBox);

  const pipeScroll = new ScrollBoxRenderable(renderer, { id: "pipeScroll", flexGrow: 1, scrollY: true });
  pipeBox.add(pipeScroll);

  const pipeText = new TextRenderable(renderer, { id: "pipeText", content: "Waiting for discovery..." });
  pipeScroll.add(pipeText);

  // ── Right: 3 stacked panels ──
  // Use flexGrow only (no fixed height) so OpenTUI's flex column distributes
  // space correctly — mixing integer height with flexGrow siblings collapses them.
  const rightCol = new BoxRenderable(renderer, {
    id: "rightCol", border: false, flexGrow: 1, flexDirection: "column",
  });
  content.add(rightCol);

  // Panel 1: Active Jobs (1 share)
  const jobsBox = new BoxRenderable(renderer, {
    id: "jobsBox", border: true, title: " Active Jobs ", flexGrow: 1,
    flexDirection: "column", borderColor: c.border,
  });
  rightCol.add(jobsBox);

  const jobsScroll = new ScrollBoxRenderable(renderer, { id: "jobsScroll", flexGrow: 1, scrollY: true });
  jobsBox.add(jobsScroll);
  const jobsText = new TextRenderable(renderer, { id: "jobsText", content: "No active jobs" });
  jobsScroll.add(jobsText);

  // Panel 2: Event Log (flexible, bigger)
  const eventsBox = new BoxRenderable(renderer, {
    id: "eventsBox", border: true, title: " Event Log ", flexGrow: 2,
    flexDirection: "column", borderColor: c.border,
  });
  rightCol.add(eventsBox);

  const eventsScroll = new ScrollBoxRenderable(renderer, { id: "eventsScroll", flexGrow: 1, scrollY: true });
  eventsBox.add(eventsScroll);
  const eventsText = new TextRenderable(renderer, { id: "eventsText", content: "No events yet" });
  eventsScroll.add(eventsText);

  // Panel 3: Captured Logs (flexible)
  const logsBox = new BoxRenderable(renderer, {
    id: "logsBox", border: true, title: " Logs ", flexGrow: 1,
    flexDirection: "column", borderColor: c.border,
  });
  rightCol.add(logsBox);

  const logsScroll = new ScrollBoxRenderable(renderer, { id: "logsScroll", flexGrow: 1, scrollY: true });
  logsBox.add(logsScroll);
  const logsText = new TextRenderable(renderer, { id: "logsText", content: "No output captured" });
  logsScroll.add(logsText);

  const footer = new TextRenderable(renderer, {
    id: "footer", height: 1,
    content: "\u2191\u2193:Nav | Enter:Detail | Tab:Focus | Esc:Back | Q:Quit",
  });
  root.add(footer);

  // ── Update display ──
  function update() {
    // Focus borders
    pipeBox.borderColor = focus === "pipeline" ? c.selected : c.border;
    jobsBox.borderColor = (focus === "jobs" || focus === "detail" as any) ? c.selected : c.border;
    eventsBox.borderColor = focus === "events" ? c.selected : c.border;
    logsBox.borderColor = focus === "logs" ? c.selected : c.border;

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

    // ── Pipeline panel ──
    if (data.phase === "starting" || data.phase === "interpreting") {
      pipeText.content = [
        data.phase === "starting"
          ? "Workflow starting up..."
          : "AI is interpreting your prompt and configuring the pipeline...",
        "",
        "This usually takes 1-2 minutes.",
      ].join("\n");
    } else if (data.phase === "discovering" && data.tickets.length === 0) {
      const lines = [
        "Discovering tickets from specs and codebase...",
        "",
        `Discovery rounds completed: ${data.discoveryCount}`,
      ];
      if (data.activeJobs.length > 0) {
        const discoverJob = data.activeJobs.find(j => j.jobType === "discovery");
        if (discoverJob) {
          lines.push("", `Running for ${fmtElapsed(discoverJob.elapsedMs)}`);
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

    // ── Jobs panel (or detail view) ──
    if (detail) {
      jobsBox.title = ` ${detail.id} `;
      const lines = [
        detail.title,
        `${detail.tier} | ${detail.priority}`,
        "",
        ...detail.stages.map(s => {
          const icon = stageIcon(s.status as StageStatus);
          const summary = s.summary ? `: ${truncate(s.summary, 35)}` : "";
          return `${s.abbr} ${icon} ${s.status}${summary}`;
        }),
      ];
      if (detail.landSummary) lines.push("", detail.landSummary);
      jobsText.content = lines.join("\n");
    } else {
      jobsBox.title = ` Active Jobs (${data.activeJobs.length}) `;
      if (data.activeJobs.length === 0) {
        if (data.phase === "starting" || data.phase === "interpreting") {
          jobsText.content = "Waiting for pipeline to start...";
        } else if (data.phase === "done") {
          jobsText.content = "\x1b[32mAll work complete!\x1b[0m";
        } else {
          jobsText.content = "No active jobs";
        }
      } else {
        const lines = data.activeJobs.map(j => {
          const type = JOB_ABBR[j.jobType] || j.jobType.replace("ticket:", "");
          const label = j.ticketId ? `${j.ticketId}:${type}` : type;
          const icon = j.jobType === "discovery" ? "\uD83D\uDD0D"
                     : j.jobType.startsWith("ticket:") ? "\u25D0"
                     : "\u2699";
          return `${icon} ${truncate(label, 22).padEnd(22)} ${fmtElapsed(j.elapsedMs)}`;
        });

        if (data.mergeQueueActivity) {
          const mq = data.mergeQueueActivity;
          lines.push("", "\x1b[1mMerge Queue:\x1b[0m");
          for (const t of mq.ticketsLanded) lines.push(`  \x1b[32m\u2714\x1b[0m ${t.ticketId}: ${truncate(t.summary, 35)}`);
          for (const t of mq.ticketsEvicted) lines.push(`  \x1b[31m\u2718\x1b[0m ${t.ticketId}: ${truncate(t.reason, 35)}`);
          for (const t of mq.ticketsSkipped) lines.push(`  \x1b[90m\u2014\x1b[0m ${t.ticketId}: ${truncate(t.reason, 35)}`);
        }

        jobsText.content = lines.join("\n");
      }
    }

    // ── Event Log panel ──
    eventsBox.title = ` Event Log (${eventLog.length}) `;
    eventsText.content = eventLog.length === 0
      ? "No events yet"
      : eventLog.slice(-40).reverse().map(e => `${e.time} ${e.message}`).join("\n");

    // ── Logs panel ──
    logsBox.title = ` Logs (${capturedLogs.length}) `;
    const logLines = capturedLogs.getAll();
    logsText.content = logLines.length === 0
      ? "No output captured"
      : logLines.slice(-40).join("\n");

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
      } catch {}

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
        } catch {}
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
    if (tickets.length > 0 && landed === tickets.length && activeJobs.length === 0) return "done";
    if (mergeQueueActive) return "merging";
    if (!hasInterpretConfig) return "interpreting";
    if (tickets.length > 0 && tickets.some(t => t.landStatus !== "landed")) return "pipeline";
    if (activeJobs.some(j => j.jobType === "discovery")) return "discovering";
    if (tickets.length === 0) return "discovering";
    return "pipeline";
  }

  // ── Poll database ──
  async function poll() {
    const now = Date.now();
    lastError = null;

    if (!existsSync(dbPath)) {
      data = { ...data, phase: "starting" };
      return;
    }

    try {
      const db = new Database(dbPath, { readonly: true });

      // 1. InterpretConfig status
      let hasInterpretConfig = false;
      try {
        const row = db.query(`SELECT 1 FROM interpret_config WHERE run_id = ? LIMIT 1`).get(runId) as any;
        hasInterpretConfig = !!row;
      } catch {}

      // 2. Discovered tickets
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
          } catch {}
        }
      } catch {}

      // 3. Node states
      const nodeState = new Map<string, string>();
      try {
        const rows = db.query(`SELECT node_id, state FROM _smithers_nodes WHERE run_id = ? ORDER BY iteration ASC`).all(runId) as any[];
        for (const r of rows) nodeState.set(r.node_id, r.state);
      } catch {}

      // 4. Active jobs — prefer scheduled-tasks.db, fall back to _smithers_attempts
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

      // Fallback: read in-progress from _smithers_attempts when scheduled-tasks.db is absent/empty
      if (activeJobs.length === 0) {
        try {
          const rows = db.query(
            `SELECT node_id, started_at_ms FROM _smithers_attempts WHERE run_id = ? AND state = 'in-progress' ORDER BY started_at_ms ASC`
          ).all(runId) as any[];
          activeJobs = rows.map(r => {
            const parts = (r.node_id as string).split(":");
            const jobType = parts.length > 1 ? `ticket:${parts[parts.length - 1]}` : r.node_id;
            const ticketId = parts.length > 1 ? parts.slice(0, -1).join(":") : null;
            return { jobType, agentId: "claude", ticketId, elapsedMs: now - (r.started_at_ms || now) };
          });
        } catch {}
      }

      // 5. Land status
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
      } catch {}

      // 6. Merge queue activity
      let mergeQueueActivity: MergeQueueActivity | null = null;
      let mergeQueueNodeActive = false;
      try {
        const mqState = nodeState.get("agentic-merge-queue");
        mergeQueueNodeActive = mqState === "in-progress";

        const rows = db.query(`SELECT tickets_landed, tickets_evicted, tickets_skipped, summary FROM merge_queue_result WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`).all(runId) as any[];
        if (rows.length > 0) {
          const row = rows[0];
          const landed = JSON.parse(row.tickets_landed || "[]");
          const evicted = JSON.parse(row.tickets_evicted || "[]");
          const skipped = JSON.parse(row.tickets_skipped || "[]");
          mergeQueueActivity = { ticketsLanded: landed, ticketsEvicted: evicted, ticketsSkipped: skipped, summary: row.summary || null };
          for (const t of landed) if (t.ticketId && !landMap.has(t.ticketId)) landMap.set(t.ticketId, "landed");
          for (const t of evicted) if (t.ticketId && !landMap.has(t.ticketId)) landMap.set(t.ticketId, "evicted");
        }
      } catch {}

      // 7. Max concurrency
      let maxConcurrency = 0;
      try {
        const row = db.query(`SELECT max_concurrency FROM interpret_config WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`).get(runId) as any;
        if (row) maxConcurrency = row.max_concurrency || 0;
      } catch {}

      // 8. Scheduler reasoning
      let schedulerReasoning: string | null = null;
      try {
        const row = db.query(`SELECT reasoning FROM ticket_schedule WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`).get(runId) as any;
        if (row) schedulerReasoning = row.reasoning;
      } catch {}

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
          stages, landStatus: landMap.get(t.id) || null,
        });
      });

      // Sort: running first, landed last, then by priority
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

      const phase = detectPhase(hasInterpretConfig, tickets, activeJobs, landed, mergeQueueNodeActive);

      // Log phase transitions
      if (phase !== prevPhase) {
        addEvent(`Phase: ${PHASE_DISPLAY[phase].label}`);
        if (phase === "discovering" && prevPhase === "interpreting") addEvent("Config interpreted — starting ticket discovery");
        else if (phase === "pipeline" && prevPhase === "discovering") addEvent(`Tickets discovered (${tickets.length}) — pipeline starting`);
        else if (phase === "merging") addEvent("Merge queue activated — landing completed tickets");
        else if (phase === "done") addEvent(`All ${tickets.length} tickets landed — workflow complete`);
        prevPhase = phase;
      }

      if (data.landed < landed) addEvent(`${landed - data.landed} ticket(s) landed (total: ${landed}/${tickets.length})`);
      if (data.evicted < evicted) addEvent(`${evicted - data.evicted} ticket(s) evicted`);
      if (data.discovered < tickets.length) addEvent(`${tickets.length - data.discovered} new ticket(s) discovered (total: ${tickets.length})`);

      data = {
        tickets, activeJobs,
        discovered: tickets.length, landed, evicted,
        inPipeline: tickets.length - landed,
        maxConcurrency, phase, mergeQueueActivity, schedulerReasoning, discoveryCount,
      };

      if (selectedIdx >= data.tickets.length) selectedIdx = Math.max(0, data.tickets.length - 1);
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

    if (seq === "\x03" || seq === "q" || seq === "Q") {
      shutdown();
      return true;
    }

    // Tab — cycle focus: pipeline → jobs → events → logs → pipeline
    if (seq === "\t") {
      const modes: Array<typeof focus> = ["pipeline", "jobs", "events", "logs"];
      const base = focus;
      const idx = modes.indexOf(base);
      focus = modes[(idx + 1) % modes.length];
      // Clear detail when leaving jobs panel
      if (focus !== "jobs") detail = null;
      update();
      return true;
    }

    // Esc — back to pipeline, clear detail
    if (seq === "\x1b") {
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
          focus = "jobs";
          fetchDetail(t.id).then(update);
        }
        return true;
      }
    }

    // Scroll in focused right panel
    const scrollMap: Record<string, any> = { jobs: jobsScroll, events: eventsScroll, logs: logsScroll };
    const activeScroll = scrollMap[focus];
    if (activeScroll) {
      if (seq === "\x1b[A") { activeScroll.scrollBy(-3, "step"); return true; }
      if (seq === "\x1b[B") { activeScroll.scrollBy(3, "step"); return true; }
    }

    return false;
  });

  // ── Main loop ──
  await poll();
  update();
  renderer.start();

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

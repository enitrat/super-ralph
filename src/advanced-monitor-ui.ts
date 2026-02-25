/**
 * Standalone OpenTUI Monitor UI logic.
 *
 * Three-panel dashboard:
 *  - Top: Global status bar (discovery, slots, landed, evicted)
 *  - Left: Pipeline kanban (per-ticket stage progress)
 *  - Right: Active jobs (with agent + timing), or ticket detail on Enter
 *
 * Shared between:
 *  - The Smithers <Monitor> component (in-workflow)
 *  - The standalone CLI launcher (for --resume)
 */

import { dirname, join } from "node:path";

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

interface PollData {
  tickets: TicketView[];
  activeJobs: ActiveJob[];
  discovered: number;
  landed: number;
  evicted: number;
  inPipeline: number;
  maxConcurrency: number;
}

interface TicketDetail {
  id: string;
  title: string;
  tier: string;
  priority: string;
  stages: Array<{ abbr: string; key: string; status: string; summary: string }>;
  landSummary?: string;
}

// --- Helpers ---

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 2) + ".." : s;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const stageIcon = (s: StageStatus) =>
  s === "completed" ? "\u2713" :   // ✓
  s === "running"   ? "\u25D0" :   // ◐
  s === "failed"    ? "\u2717" :   // ✗
  "\u00B7";                        // ·

// --- Exports ---

export interface MonitorUIOptions {
  dbPath: string;
  runId: string;
  projectName: string;
  prompt: string;
}

export async function runMonitorUI(opts: MonitorUIOptions): Promise<{ started: boolean; status: string }> {
  const { dbPath, runId, projectName, prompt } = opts;

  const ot = await import("@opentui/core");
  const { createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable } = ot;
  const RGBA = ot.RGBA;
  const { Database } = await import("bun:sqlite");

  const scheduledDbPath = join(dirname(dbPath), "..", "scheduled-tasks.db");

  const renderer = await createCliRenderer({
    useAlternateScreen: true,
    useMouse: false,
    exitOnCtrlC: false,
  });

  // ── State ──
  let data: PollData = { tickets: [], activeJobs: [], discovered: 0, landed: 0, evicted: 0, inPipeline: 0, maxConcurrency: 0 };
  let selectedIdx = 0;
  let focus: "pipeline" | "jobs" | "detail" = "pipeline";
  let detail: TicketDetail | null = null;
  let isRunning = true;

  // ── Colors ──
  const c = {
    border:   RGBA.fromInts(75, 85, 99),
    selected: RGBA.fromInts(6, 182, 212),
  };

  // ── Layout ──
  const root = new BoxRenderable(renderer, {
    id: "root", border: true, title: ` Super Ralph: ${projectName} `,
    width: "100%", height: "100%", flexDirection: "column",
  });
  renderer.root.add(root);

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

  // Right: Jobs / Detail
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
    content: "\u2191\u2193: Navigate | Enter: Details | Tab: Switch | Esc: Back | Q: Quit",
  });
  root.add(footer);

  // ── Update display ──
  function update() {
    pipeBox.borderColor = focus === "pipeline" ? c.selected : c.border;
    rightBox.borderColor = focus !== "pipeline" ? c.selected : c.border;

    // Stats bar
    const { discovered, landed, evicted, inPipeline, activeJobs, maxConcurrency } = data;
    const slots = maxConcurrency ? `${activeJobs.length}/${maxConcurrency}` : `${activeJobs.length}`;
    statsText.content = `Discovered: ${discovered} | In Pipeline: ${inPipeline} | Landed: ${landed} | Evicted: ${evicted} | Jobs: ${slots}`;

    // Pipeline panel
    if (data.tickets.length === 0) {
      pipeText.content = "Waiting for discovery...";
    } else {
      const lines = data.tickets.map((t, i) => {
        const sel = (i === selectedIdx && focus === "pipeline") ? "> " : "  ";
        const name = truncate(t.title || t.id, 20).padEnd(20);
        const stages = t.stages.map(s => stageIcon(s.status)).join("");
        const tier = (TIER_ABBR[t.tier] || t.tier.slice(0, 3)).padEnd(3);
        const pri = PRIORITY_ABBR[t.priority] || t.priority.slice(0, 2);
        const land = t.landStatus === "landed" ? " \u2714" : t.landStatus === "evicted" ? " \u2718" : "";
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
    } else {
      rightBox.title = ` Active Jobs (${data.activeJobs.length}) `;
      if (data.activeJobs.length === 0) {
        rightText.content = "No active jobs";
      } else {
        rightText.content = data.activeJobs.map(j => {
          const type = JOB_ABBR[j.jobType] || j.jobType.replace("ticket:", "");
          const label = j.ticketId ? `${j.ticketId}:${type}` : type;
          return `\u25D0 ${truncate(label, 20).padEnd(20)} ${truncate(j.agentId, 10).padEnd(10)} ${fmtElapsed(j.elapsedMs)}`;
        }).join("\n");
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
            const row = db.query(`SELECT ${col} FROM ${sd.table} WHERE run_id = ? AND node_id = ?`)
              .get(runId, `${ticketId}:${sd.nodeId}`) as any;
            if (row) summary = String(row[col] ?? "");
          } catch {}
        }
        stages.push({ abbr: sd.abbr, key: sd.key, status: stageView?.status || "pending", summary });
      }

      let landSummary: string | undefined;
      try {
        const row = db.query(`SELECT summary FROM land WHERE run_id = ? AND node_id = ?`)
          .get(runId, `${ticketId}:land`) as any;
        if (row) landSummary = row.summary;
      } catch {}

      db.close();
      detail = { id: ticket.id, title: ticket.title, tier: ticket.tier, priority: ticket.priority, stages, landSummary };
    } catch {}
  }

  // ── Poll database ──
  async function poll() {
    const now = Date.now();
    try {
      const db = new Database(dbPath, { readonly: true });

      // 1. All discovered tickets
      const ticketMap = new Map<string, { id: string; title: string; tier: string; priority: string }>();
      try {
        const rows = db.query(`SELECT tickets FROM discover WHERE run_id = ?`).all(runId) as any[];
        for (const row of rows) {
          try {
            const arr = JSON.parse(row.tickets);
            if (!Array.isArray(arr)) continue;
            for (const t of arr) {
              if (t?.id && !ticketMap.has(t.id)) {
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

      // 2. Node states from Smithers (one query for all)
      const nodeState = new Map<string, string>(); // node_id -> state
      try {
        const rows = db.query(
          `SELECT node_id, state FROM _smithers_nodes WHERE run_id = ? ORDER BY iteration ASC`
        ).all(runId) as any[];
        for (const r of rows) nodeState.set(r.node_id, r.state);
      } catch {}

      // 3. Active jobs from scheduled-tasks DB
      let activeJobs: ActiveJob[] = [];
      try {
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
      } catch {}

      // 4. Land status
      const landMap = new Map<string, "landed" | "evicted">();
      try {
        const rows = db.query(`SELECT node_id, merged, evicted FROM land WHERE run_id = ?`).all(runId) as any[];
        for (const r of rows) {
          const tid = r.node_id.replace(/:land$/, "");
          if (r.merged) landMap.set(tid, "landed");
          else if (r.evicted) landMap.set(tid, "evicted");
        }
      } catch {}

      // 5. Max concurrency
      let maxConcurrency = 0;
      try {
        const row = db.query(`SELECT max_concurrency FROM interpret_config WHERE run_id = ? LIMIT 1`).get(runId) as any;
        if (row) maxConcurrency = row.max_concurrency || 0;
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

      data = {
        tickets, activeJobs,
        discovered: tickets.length, landed, evicted,
        inPipeline: tickets.length - landed,
        maxConcurrency,
      };

      if (selectedIdx >= data.tickets.length) {
        selectedIdx = Math.max(0, data.tickets.length - 1);
      }
    } catch {}
  }

  // ── Input handler ──
  renderer.prependInputHandler((seq: string) => {
    if (!isRunning) return false;

    if (seq === "q" || seq === "Q") {
      isRunning = false;
      renderer.destroy();
      return true;
    }

    if (seq === "\t") {
      if (focus === "detail") { focus = "pipeline"; detail = null; }
      else { focus = focus === "pipeline" ? "jobs" : "pipeline"; }
      update();
      return true;
    }

    if (seq === "\x1b" && focus === "detail") {
      focus = "pipeline";
      detail = null;
      update();
      return true;
    }

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

    if (focus === "jobs" || focus === "detail") {
      if (seq === "\x1b[A") { rightScroll.scrollBy(-3, "step"); return true; }
      if (seq === "\x1b[B") { rightScroll.scrollBy(3, "step"); return true; }
    }

    return false;
  });

  // ── Main loop ──
  await poll();
  update();
  renderer.start();

  while (isRunning) {
    await new Promise(r => setTimeout(r, 2000));
    if (!isRunning) break;
    await poll();
    update();
  }

  return { started: true, status: "stopped" };
}

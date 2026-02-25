import React from "react";
import { Task } from "smithers-orchestrator";
import { z } from "zod";
import { dirname, join } from "node:path";
import type { ClarificationSession } from "../cli/clarifications";
import { runMonitorUI } from "../advanced-monitor-ui";

export const monitorOutputSchema = z.object({
  started: z.boolean(),
  status: z.string(),
});

export type MonitorOutput = z.infer<typeof monitorOutputSchema>;

export type MonitorProps = {
  dbPath: string;
  runId: string;
  config: any;
  clarificationSession: ClarificationSession | null;
  prompt: string;
  repoRoot: string;
};

/**
 * Monitor Smithers Component - OpenTUI Dashboard
 *
 * Features:
 * - Workflow phase awareness (interpreting → discovering → pipeline → merging → done)
 * - Real-time task list with color-coded stage progress
 * - Event log tracking phase transitions and key milestones
 * - Captured stdout/stderr logs panel (prevents TUI corruption)
 * - Navigate tickets with arrow keys, drill into details
 *
 * The monitor TUI is started in a fire-and-forget manner so it does not
 * block the Smithers engine loop.  Without this, a `<Parallel>` sibling
 * like `<SuperRalph>` can never advance its Ralph iteration because the
 * engine's `Promise.all` waits for every runnable task — including this
 * never-finishing polling loop — before re-rendering.
 *
 * See: https://github.com/evmts/super-ralph/issues/6
 */
export function Monitor({
  dbPath,
  runId,
  config,
  prompt,
  repoRoot,
}: MonitorProps) {
  // On --resume the CLI spawns a standalone monitor process, so skip the
  // in-workflow monitor to avoid two TUI instances fighting for the terminal.
  if (process.env.SUPER_RALPH_SKIP_MONITOR === "1") {
    return (
      <Task id="monitor" output={monitorOutputSchema} continueOnFail={true}>
        {async () => ({ started: false, status: "skipped-standalone-active" })}
      </Task>
    );
  }

  // Log file lives next to the Smithers DB
  const logFile = join(dirname(dbPath), "monitor.log");

  return (
    <Task
      id="monitor"
      output={monitorOutputSchema}
      continueOnFail={true}
    >
      {async () => {
        // Start the TUI without awaiting it — the polling loop runs in
        // the background while the Task completes immediately, unblocking
        // the engine so sibling components can iterate.
        runMonitorUI({
          dbPath,
          runId,
          projectName: config.projectName || "Workflow",
          prompt,
          logFile,
        }).catch((err) => {
          // Use origStdoutWrite if available, otherwise best-effort
          const msg = `[Monitor] TUI crashed: ${err instanceof Error ? err.message : String(err)}\n`;
          try { process.stderr.write(msg); } catch { /* console already captured */ }
        });
        return { started: true, status: "running" };
      }}
    </Task>
  );
}

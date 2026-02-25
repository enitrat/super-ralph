import React from "react";
import { Task } from "smithers-orchestrator";
import { z } from "zod";
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
 * - Real-time task list with status indicators
 * - Navigate tasks with arrow keys
 * - View task details
 * - Overall workflow progress
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
        }).catch((err) => {
          process.stderr.write(`[Monitor] TUI crashed: ${err instanceof Error ? err.message : String(err)}\n`);
        });
        return { started: true, status: "running" };
      }}
    </Task>
  );
}

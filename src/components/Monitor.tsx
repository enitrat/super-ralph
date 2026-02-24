import React from "react";
import { Task } from "smithers-orchestrator";
import { z } from "zod";
import type { ClarificationSession } from "../cli/clarifications";
import { runMonitorUI } from "../monitor-ui";

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
 */
export function Monitor({
  dbPath,
  runId,
  config,
  prompt,
}: MonitorProps) {
  return (
    <Task
      id="monitor"
      output={monitorOutputSchema}
      continueOnFail={true}
    >
      {async () => {
        return runMonitorUI({
          dbPath,
          runId,
          projectName: config.projectName || "Workflow",
          prompt,
        });
      }}
    </Task>
  );
}

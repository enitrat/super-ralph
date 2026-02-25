#!/usr/bin/env bun
/**
 * Standalone Monitor - launched alongside Smithers on --resume
 *
 * Usage: bun src/cli/monitor-standalone.ts <dbPath> <runId> [projectName] [prompt]
 */

import { runMonitorUI } from "../advanced-monitor-ui";

const [dbPath, runId, projectName, prompt] = process.argv.slice(2);

if (!dbPath || !runId) {
  console.error("Usage: bun monitor-standalone.ts <dbPath> <runId> [projectName] [prompt]");
  process.exit(1);
}

runMonitorUI({
  dbPath,
  runId,
  projectName: projectName || "Workflow",
  prompt: prompt || "",
}).catch((err) => {
  console.error("Monitor error:", err);
  process.exit(1);
});

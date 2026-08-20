import path from "node:path";
import { asRunId, type RunId } from "../contracts/ids";

export function resolveRunDir(projectDir: string, runId: RunId): string {
  const validatedRunId = asRunId(runId);
  const runsDir = path.resolve(projectDir, ".omni", "v4", "runs");
  const runDir = path.resolve(runsDir, validatedRunId);
  // Ensure runDir is strictly contained within runsDir
  const relative = path.relative(runsDir, runDir);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error(`Invalid runId escaping root directory: ${runId}`);
  }
  return runDir;
}

export function resolveEventsPath(projectDir: string, runId: RunId): string {
  return path.join(resolveRunDir(projectDir, runId), "events.ndjson");
}

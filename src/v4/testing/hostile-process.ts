import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";

export const HOSTILE_PROCESS_PHASES = [
  "INTAKE",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "FIX",
  "ACCEPT",
  "REWORK",
  "DOCUMENT",
] as const;

export const HOSTILE_LIFECYCLE_CUT_POINTS = [
  { id: "created-init", expectedRecoveryKind: "continue", expectedRecoveredPhase: "INTAKE" },
  { id: "transitioned-plan", expectedRecoveryKind: "continue", expectedRecoveredPhase: "PLAN" },
  { id: "step-started-workspace-write", expectedRecoveryKind: "blocked", expectedRecoveredPhase: "BLOCKED" },
  { id: "step-succeeded-before-transition", expectedRecoveryKind: "continue", expectedRecoveredPhase: "PLAN" },
  { id: "quality-started-verify", expectedRecoveryKind: "blocked", expectedRecoveredPhase: "BLOCKED" },
  { id: "quality-started-accept", expectedRecoveryKind: "blocked", expectedRecoveredPhase: "BLOCKED" },
  { id: "document-artifact-reverify", expectedRecoveryKind: "blocked", expectedRecoveredPhase: "BLOCKED" },
  { id: "ready-artifact-reverify", expectedRecoveryKind: "blocked", expectedRecoveredPhase: "BLOCKED" },
] as const;

const PhaseResultSchema = z.object({
  phase: z.enum(HOSTILE_PROCESS_PHASES),
  markerObserved: z.literal(true),
  killExternal: z.literal(true),
  killSignal: z.literal("SIGKILL"),
  firstProcessExited: z.literal(true),
  secondProcessStarted: z.literal(true),
  recoveryKind: z.enum(["rerun", "blocked", "continue"]),
  recoveredPhase: z.string().min(1),
}).strict();

const CutPointResultSchema = z.object({
  id: z.enum(HOSTILE_LIFECYCLE_CUT_POINTS.map((item) => item.id) as [
    (typeof HOSTILE_LIFECYCLE_CUT_POINTS)[number]["id"],
    ...(typeof HOSTILE_LIFECYCLE_CUT_POINTS)[number]["id"][],
  ]),
  markerObserved: z.literal(true),
  killExternal: z.literal(true),
  killSignal: z.literal("SIGKILL"),
  firstProcessExited: z.literal(true),
  secondProcessStarted: z.literal(true),
  recoveryKind: z.enum(["rerun", "blocked", "continue"]),
  recoveredPhase: z.string().min(1),
}).strict();

export const HostileProcessEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  evidenceId: z.string().regex(/^hostile-process-[0-9a-f]{16}$/),
  platform: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  phases: z.array(PhaseResultSchema).length(HOSTILE_PROCESS_PHASES.length),
  cutPoints: z.array(CutPointResultSchema).length(HOSTILE_LIFECYCLE_CUT_POINTS.length),
  externalKillCount: z.number().int().nonnegative(),
  recoveryProcessCount: z.number().int().nonnegative(),
  falseSuccessCount: z.number().int().nonnegative(),
  qualified: z.boolean(),
}).strict();

export type HostileProcessEvidence = z.infer<typeof HostileProcessEvidenceSchema>;

export interface HostileProcessQualificationOptions {
  readonly outputRoot: string;
  readonly workingRoot: string;
  readonly now?: () => string;
  readonly markerTimeoutMs?: number;
}

async function waitForMarker(markerPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      if (typeof marker.pid === "number" && typeof marker.operationId === "string") return;
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`HOSTILE_MARKER_TIMEOUT: ${path.basename(markerPath)}`);
}

async function waitForMarkerOrEarlyExit(
  markerPath: string,
  timeoutMs: number,
  completion: Promise<{ code: number | null; stdout: string; stderr: string }>,
  caseId: string
): Promise<void> {
  await Promise.race([
    waitForMarker(markerPath, timeoutMs),
    completion.then((result) => {
      throw new Error(`HOSTILE_SEED_EXITED_EARLY: ${caseId}: ${result.stderr.trim()}`);
    }),
  ]);
}

function spawnChild(
  fixturePath: string,
  args: readonly string[]
): { child: ReturnType<typeof spawn>; completion: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, ...args], {
    cwd: path.resolve(__dirname, "../../.."),
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, completion };
}

export function renderHostileProcessMarkdown(evidence: HostileProcessEvidence): string {
  const item = HostileProcessEvidenceSchema.parse(evidence);
  return [
    "# Hostile Process Kill/Restart Evidence",
    "",
    `- Evidence: \`${item.evidenceId}\``,
    `- Platform: \`${item.platform}\``,
    `- Started: ${item.startedAt}`,
    `- Completed: ${item.completedAt}`,
    `- External kills: ${item.externalKillCount}`,
    `- Recovery processes: ${item.recoveryProcessCount}`,
    `- False successes: ${item.falseSuccessCount}`,
    `- Qualified: ${item.qualified}`,
    "",
    "| Phase | Marker | External kill | Signal | Recovery | Recovered phase |",
    "| --- | --- | --- | --- | --- | --- |",
    ...item.phases.map(
      (phase) => `| ${phase.phase} | ${phase.markerObserved} | ${phase.killExternal} | ${phase.killSignal} | ${phase.recoveryKind} | ${phase.recoveredPhase} |`
    ),
    "",
    "| Lifecycle cut point | Marker | External kill | Signal | Recovery | Recovered phase |",
    "| --- | --- | --- | --- | --- | --- |",
    ...item.cutPoints.map(
      (cutPoint) => `| ${cutPoint.id} | ${cutPoint.markerObserved} | ${cutPoint.killExternal} | ${cutPoint.killSignal} | ${cutPoint.recoveryKind} | ${cutPoint.recoveredPhase} |`
    ),
    "",
  ].join("\n");
}

export async function runHostileProcessQualification(
  options: HostileProcessQualificationOptions
): Promise<{ readonly evidence: HostileProcessEvidence; readonly jsonPath: string; readonly markdownPath: string }> {
  const now = options.now ?? (() => new Date().toISOString());
  const markerTimeoutMs = options.markerTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(markerTimeoutMs) || markerTimeoutMs <= 0) {
    throw new Error("HOSTILE_PROCESS_INVALID_TIMEOUT");
  }
  const startedAt = now();
  const fixturePath = path.resolve(__dirname, "../../../test/fixtures/v4/hostile-process-child.ts");
  const lifecycleFixturePath = path.resolve(__dirname, "../../../test/fixtures/v4/hostile-lifecycle-child.ts");
  await fs.mkdir(options.workingRoot, { recursive: true });
  const phases: Array<z.infer<typeof PhaseResultSchema>> = [];
  const cutPoints: Array<z.infer<typeof CutPointResultSchema>> = [];

  for (const phase of HOSTILE_PROCESS_PHASES) {
    const workspace = path.resolve(options.workingRoot, phase.toLowerCase());
    const markerPath = path.join(workspace, "hostile-marker.json");
    await fs.mkdir(workspace, { recursive: true });
    const first = spawnChild(fixturePath, ["seed", workspace, phase, markerPath]);
    try {
      await waitForMarkerOrEarlyExit(markerPath, markerTimeoutMs, first.completion, phase);
    } catch (error) {
      first.child.kill("SIGKILL");
      await first.completion.catch(() => undefined);
      throw new Error(`HOSTILE_SEED_NOT_READY: ${phase}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const killed = first.child.kill("SIGKILL");
    if (!killed) throw new Error(`HOSTILE_EXTERNAL_KILL_FAILED: ${phase}`);
    const firstExit = await first.completion;
    if (firstExit.code === 0) throw new Error(`HOSTILE_FIRST_PROCESS_FALSE_SUCCESS: ${phase}`);

    const second = spawnChild(fixturePath, ["recover", workspace, phase, markerPath]);
    const recovered = await second.completion;
    if (recovered.code !== 0) {
      throw new Error(`HOSTILE_RECOVERY_FAILED: ${phase}: ${recovered.stderr.trim()}`);
    }
    const recovery = JSON.parse(recovered.stdout.trim()) as { kind: string; phase: string };
    phases.push({
      phase,
      markerObserved: true,
      killExternal: true,
      killSignal: "SIGKILL",
      firstProcessExited: true,
      secondProcessStarted: true,
      recoveryKind: recovery.kind as "rerun" | "blocked" | "continue",
      recoveredPhase: recovery.phase,
    });
  }

  for (const cutPoint of HOSTILE_LIFECYCLE_CUT_POINTS) {
    const workspace = path.resolve(options.workingRoot, `cut-${cutPoint.id}`);
    const markerPath = path.join(workspace, "hostile-marker.json");
    await fs.mkdir(workspace, { recursive: true });
    const first = spawnChild(lifecycleFixturePath, ["seed", workspace, cutPoint.id, markerPath]);
    try {
      await waitForMarkerOrEarlyExit(markerPath, markerTimeoutMs, first.completion, cutPoint.id);
    } catch (error) {
      first.child.kill("SIGKILL");
      await first.completion.catch(() => undefined);
      throw new Error(`HOSTILE_SEED_NOT_READY: ${cutPoint.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const killed = first.child.kill("SIGKILL");
    if (!killed) throw new Error(`HOSTILE_EXTERNAL_KILL_FAILED: ${cutPoint.id}`);
    const firstExit = await first.completion;
    if (firstExit.code === 0) throw new Error(`HOSTILE_FIRST_PROCESS_FALSE_SUCCESS: ${cutPoint.id}`);
    const second = spawnChild(lifecycleFixturePath, ["recover", workspace, cutPoint.id, markerPath]);
    const recovered = await second.completion;
    if (recovered.code !== 0) {
      throw new Error(`HOSTILE_RECOVERY_FAILED: ${cutPoint.id}: ${recovered.stderr.trim()}`);
    }
    const recovery = JSON.parse(recovered.stdout.trim()) as { kind: string; phase: string };
    cutPoints.push({
      id: cutPoint.id,
      markerObserved: true,
      killExternal: true,
      killSignal: "SIGKILL",
      firstProcessExited: true,
      secondProcessStarted: true,
      recoveryKind: recovery.kind as "rerun" | "blocked" | "continue",
      recoveredPhase: recovery.phase,
    });
  }

  const completedAt = now();
  const body = {
    platform: `${process.platform}-${process.arch}`,
    startedAt,
    completedAt,
    phases,
    cutPoints,
    externalKillCount: phases.length + cutPoints.length,
    recoveryProcessCount: phases.length + cutPoints.length,
    falseSuccessCount:
      phases.filter((item) => item.recoveredPhase === "READY").length +
      cutPoints.filter((item, index) =>
        item.recoveryKind !== HOSTILE_LIFECYCLE_CUT_POINTS[index]!.expectedRecoveryKind ||
        item.recoveredPhase !== HOSTILE_LIFECYCLE_CUT_POINTS[index]!.expectedRecoveredPhase
      ).length,
    qualified:
      phases.every((item) => item.recoveryKind === "rerun" && item.recoveredPhase !== "READY") &&
      cutPoints.every((item, index) =>
        item.recoveryKind === HOSTILE_LIFECYCLE_CUT_POINTS[index]!.expectedRecoveryKind &&
        item.recoveredPhase === HOSTILE_LIFECYCLE_CUT_POINTS[index]!.expectedRecoveredPhase
      ),
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const evidence = HostileProcessEvidenceSchema.parse({
    schemaVersion: 1,
    evidenceId: `hostile-process-${digest}`,
    ...body,
  });
  const outputDir = path.resolve(options.outputRoot, completedAt.slice(0, 10), evidence.evidenceId);
  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "evidence.json");
  const markdownPath = path.join(outputDir, "evidence.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" }),
    fs.writeFile(markdownPath, renderHostileProcessMarkdown(evidence), { flag: "wx" }),
  ]);
  return { evidence, jsonPath, markdownPath };
}

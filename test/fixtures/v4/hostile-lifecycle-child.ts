import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RunController } from "../../../src/v4/core/controller";
import { createDefaultPolicy } from "../../../src/v4/policy/default-policy";
import { FileArtifactStore } from "../../../src/v4/storage/artifact-store";
import { FileEventStore } from "../../../src/v4/storage/event-store";
import { asEventId, asQualityCycleId, asRunId, asStepId } from "../../../src/v4/contracts";
import type { AdapterContext, AdapterProbe, AgentAdapter, StepRequest } from "../../../src/v4/contracts/adapter";

const normalPhases = ["INTAKE", "PLAN", "EXECUTE", "VERIFY", "ACCEPT", "DOCUMENT"] as const;

async function durableMarker(markerPath: string, value: object): Promise<never> {
  const handle = await fs.open(markerPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ ...value, pid: process.pid })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await new Promise<never>(() => {
    setInterval(() => {}, 60_000);
  });
}

class LifecycleAdapter implements AgentAdapter {
  readonly id = "hostile-lifecycle";
  constructor(
    private readonly hangPhase?: string,
    private readonly markerPath?: string
  ) {}
  async probe(): Promise<AdapterProbe> {
    return {
      adapterId: this.id,
      available: true,
      capabilities: ["workspace.read", "workspace.write", "structured-output"],
      diagnostics: [],
    };
  }
  async execute(request: StepRequest, _context: AdapterContext): Promise<unknown> {
    if (request.phase === this.hangPhase && this.markerPath) {
      return durableMarker(this.markerPath, { phase: request.phase, operationId: request.operationId });
    }
    const artifactId = `artifact-${request.operationId}`;
    return {
      status: "succeeded",
      executionId: request.operationId,
      summary: `completed ${request.phase}`,
      artifacts: [{ artifactId, kind: "file", relativePath: `${request.phase}.txt` }],
      evidence: [{
        schemaVersion: 1,
        kind: "artifact",
        producerStepId: request.stepId,
        method: "write",
        startedAt: "2026-08-29T00:00:00.000Z",
        durationMs: 1,
        artifactIds: [artifactId],
        summary: `verified ${request.phase}`,
      }],
    };
  }
  async cancel(): Promise<void> {}
}

async function main(): Promise<void> {
  const [mode, workspaceDir, cutPoint, markerPath] = process.argv.slice(2);
  if (!mode || !workspaceDir || !cutPoint || !markerPath) throw new Error("LIFECYCLE_CHILD_INVALID_ARGS");
  const runId = asRunId(`hostile-cut-${cutPoint}`);
  let eventSeq = 0;
  const eventStore = new FileEventStore({ projectDir: workspaceDir });
  const controller = new RunController({
    adapter: new LifecycleAdapter(
      cutPoint === "step-started-workspace-write" ? "INTAKE" : undefined,
      cutPoint === "step-started-workspace-write" ? markerPath : undefined
    ),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  if (mode === "recover") {
    const result = await controller.resume(runId);
    process.stdout.write(`${JSON.stringify({ kind: result.kind, phase: result.state.phase })}\n`);
    return;
  }
  if (mode !== "seed") throw new Error("LIFECYCLE_CHILD_UNKNOWN_MODE");

  await fs.mkdir(workspaceDir, { recursive: true });
  for (const phase of normalPhases) {
    await fs.writeFile(path.join(workspaceDir, `${phase}.txt`), `${phase}\n`, "utf8");
  }
  await controller.start({ runId });

  const executeThrough = async (lastPhase: typeof normalPhases[number]) => {
    const end = normalPhases.indexOf(lastPhase);
    for (let index = 0; index <= end; index++) {
      const phase = normalPhases[index]!;
      await controller.executeNext({
        runId,
        stepId: asStepId(`step-${index}-${phase.toLowerCase()}`),
        phase,
        operationId: `op-${index}-${phase.toLowerCase()}`,
        workspaceDir,
        prompt: `complete ${phase}`,
        requiredCapabilities: ["workspace.read"],
        sideEffect: cutPoint === "step-started-workspace-write" ? "workspace-write" : "read-only",
        timeoutMs: 300_000,
      });
    }
  };

  if (cutPoint === "created-init") {
    return durableMarker(markerPath, { cutPoint, operationId: cutPoint });
  }
  if (cutPoint === "transitioned-plan") {
    await executeThrough("INTAKE");
    return durableMarker(markerPath, { cutPoint, operationId: cutPoint });
  }
  if (cutPoint === "step-started-workspace-write") {
    await executeThrough("INTAKE");
    throw new Error("WORKSPACE_WRITE_HANG_RETURNED");
  }
  if (cutPoint === "step-succeeded-before-transition") {
    const startedId = asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`);
    await eventStore.append({
      schemaVersion: 1,
      eventId: startedId,
      runId,
      sequence: 1,
      at: new Date().toISOString(),
      type: "step.started",
      payload: {
        stepId: asStepId("step-post-success"), operationId: "op-post-success", phase: "INTAKE",
        sideEffect: "read-only", workspaceDir,
      },
    }, 0);
    const artifactId = "artifact-post-success" as import("../../../src/v4/contracts/ids").ArtifactId;
    const record = await new FileArtifactStore().record({
      workspaceDir,
      runId,
      producerStepId: asStepId("step-post-success"),
      claim: { artifactId, kind: "file", relativePath: "INTAKE.txt" },
      recordedAt: new Date().toISOString(),
    });
    await eventStore.append({
      schemaVersion: 1,
      eventId: asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
      runId,
      sequence: 2,
      at: new Date().toISOString(),
      type: "artifact.recorded",
      payload: { record },
    }, 1);
    const succeededId = asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`);
    await eventStore.append({
      schemaVersion: 1,
      eventId: succeededId,
      runId,
      sequence: 3,
      at: new Date().toISOString(),
      type: "step.succeeded",
      payload: {
        stepId: asStepId("step-post-success"), operationId: "op-post-success",
        result: {
          status: "succeeded", executionId: "op-post-success", summary: "durable success",
          artifacts: [{ artifactId, kind: "file", relativePath: "INTAKE.txt" }],
          evidence: [{
            schemaVersion: 1, kind: "artifact", producerStepId: asStepId("step-post-success"),
            method: "write", startedAt: "2026-08-29T00:00:00.000Z", durationMs: 1,
            artifactIds: [artifactId], summary: "verified post-success artifact",
          }],
        },
      },
    }, 2);
    return durableMarker(markerPath, { cutPoint, operationId: cutPoint });
  }
  if (cutPoint === "quality-started-verify" || cutPoint === "quality-started-accept") {
    await executeThrough(cutPoint === "quality-started-verify" ? "EXECUTE" : "VERIFY");
    const state = await controller.getState(runId);
    await eventStore.append({
      schemaVersion: 1,
      eventId: asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
      runId,
      sequence: state.sequence + 1,
      at: new Date().toISOString(),
      type: "quality.started",
      payload: { cycleId: asQualityCycleId(`cycle-${cutPoint}`), phase: state.phase, startedAt: new Date().toISOString() },
    }, state.sequence);
    return durableMarker(markerPath, { cutPoint, operationId: cutPoint });
  }
  if (cutPoint === "document-artifact-reverify" || cutPoint === "ready-artifact-reverify") {
    await executeThrough(cutPoint === "document-artifact-reverify" ? "ACCEPT" : "DOCUMENT");
    await fs.writeFile(path.join(workspaceDir, "INTAKE.txt"), "tampered\n", "utf8");
    return durableMarker(markerPath, { cutPoint, operationId: cutPoint });
  }
  throw new Error(`LIFECYCLE_CHILD_UNKNOWN_CUT_POINT: ${cutPoint}`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { RunController } from "../../../src/v4/core/controller";
import { createDefaultPolicy } from "../../../src/v4/policy/default-policy";
import { FileEventStore } from "../../../src/v4/storage/event-store";
import { FileArtifactStore } from "../../../src/v4/storage/artifact-store";
import {
  asArtifactId,
  asEventId,
  asRunId,
  asStepId,
} from "../../../src/v4/contracts/ids";
import { asQualityCycleId, asRequirementId } from "../../../src/v4/contracts/quality";
import type { AdapterContext, AdapterProbe, AgentAdapter, StepRequest } from "../../../src/v4/contracts/adapter";
import type { RunPhase } from "../../../src/v4/contracts/run";

const phases = ["INTAKE", "PLAN", "EXECUTE", "VERIFY", "FIX", "ACCEPT", "REWORK", "DOCUMENT"] as const;
const normalPhases = ["INTAKE", "PLAN", "EXECUTE", "VERIFY", "ACCEPT", "DOCUMENT"] as const;

class HostileChildAdapter implements AgentAdapter {
  readonly id = "hostile-child";
  constructor(
    private readonly target: RunPhase,
    private readonly markerPath: string
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
    if (request.phase === this.target) {
      const marker = await fs.open(this.markerPath, "wx");
      try {
        await marker.writeFile(
          `${JSON.stringify({ phase: request.phase, operationId: request.operationId, pid: process.pid })}\n`,
          "utf8"
        );
        await marker.sync();
      } finally {
        await marker.close();
      }
      await new Promise<never>(() => {});
    }
    const relativePath = `${request.phase}.txt`;
    const artifactId = asArtifactId(`artifact-${request.phase.toLowerCase()}`);
    return {
      status: "succeeded",
      executionId: request.operationId,
      summary: `completed ${request.phase}`,
      artifacts: [{ artifactId, kind: "file", relativePath }],
      evidence: [
        {
          schemaVersion: 1,
          kind: "artifact",
          producerStepId: request.stepId,
          method: "write",
          startedAt: "2026-08-29T00:00:00.000Z",
          durationMs: 1,
          artifactIds: [artifactId],
          summary: `verified ${request.phase}`,
        },
      ],
    };
  }

  async cancel(): Promise<void> {}
}

async function main(): Promise<void> {
  const [mode, workspaceDir, phaseRaw, markerPath] = process.argv.slice(2);
  if (!mode || !workspaceDir || !phaseRaw || !markerPath || !phases.includes(phaseRaw as any)) {
    throw new Error("HOSTILE_CHILD_INVALID_ARGS");
  }
  const target = phaseRaw as (typeof phases)[number];
  const runId = asRunId(`hostile-${target.toLowerCase()}`);
  let eventSeq = 0;
  const eventStore = new FileEventStore({ projectDir: workspaceDir });
  const controller = new RunController({
    adapter: new HostileChildAdapter(target, markerPath),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  if (mode === "seed") {
    await fs.mkdir(workspaceDir, { recursive: true });
    for (const phase of phases) {
      await fs.writeFile(path.join(workspaceDir, `${phase}.txt`), `${phase}\n`, "utf8");
    }
    await controller.start({ runId });

    const prerequisites =
      target === "FIX"
        ? normalPhases.slice(0, 3)
        : target === "REWORK"
          ? normalPhases.slice(0, 4)
          : normalPhases.slice(0, normalPhases.indexOf(target as any));
    for (const [index, phase] of prerequisites.entries()) {
      await controller.executeNext({
        runId,
        stepId: asStepId(`step-${phase.toLowerCase()}`),
        phase,
        operationId: `op-${index}-${phase.toLowerCase()}`,
        workspaceDir,
        prompt: `hostile cut point ${phase}`,
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read-only",
        timeoutMs: 300_000,
      });
    }

    if (target === "FIX" || target === "REWORK") {
      const current = await controller.getState(runId);
      const from = target === "FIX" ? "VERIFY" : "ACCEPT";
      if (current.phase !== from) throw new Error(`HOSTILE_CHILD_ROUTE_PHASE_MISMATCH: ${current.phase}`);
      const completedEventId = asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`);
      await eventStore.append(
        {
          schemaVersion: 1,
          eventId: completedEventId,
          runId,
          sequence: current.sequence + 1,
          at: new Date().toISOString(),
          type: "quality.completed",
          payload: {
            cycleId: asQualityCycleId(`cycle-${target.toLowerCase()}`),
            decision: {
              kind: "repair",
              to: target,
              requirementIds: [asRequirementId("R-hostile")],
            },
            completedAt: new Date().toISOString(),
          },
        },
        current.sequence
      );
      await eventStore.append(
        {
          schemaVersion: 1,
          eventId: asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
          runId,
          sequence: current.sequence + 2,
          at: new Date().toISOString(),
          type: "run.routed",
          payload: { from, to: target, causedByEventId: completedEventId },
        },
        current.sequence + 1
      );
    }

    const targetIndex = phases.indexOf(target);
    await controller.executeNext({
      runId,
      stepId: asStepId(`step-${target.toLowerCase()}`),
      phase: target,
      operationId: `op-${targetIndex}-${target.toLowerCase()}`,
      workspaceDir,
      prompt: `hostile cut point ${target}`,
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read-only",
      timeoutMs: 300_000,
    });
    throw new Error("HOSTILE_CHILD_TARGET_RETURNED");
  }

  if (mode === "recover") {
    const result = await controller.resume(runId);
    process.stdout.write(`${JSON.stringify({ kind: result.kind, phase: result.state.phase })}\n`);
    return;
  }
  throw new Error("HOSTILE_CHILD_UNKNOWN_MODE");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

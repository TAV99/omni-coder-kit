import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QualityCoordinator } from "../../src/v4/quality/quality-coordinator";
import { FileEventStore } from "../../src/v4/storage/event-store";
import { EvidenceBundleStore } from "../../src/v4/quality/evidence-bundle-store";
import { GateRegistry } from "../../src/v4/quality/gate-registry";
import { GateRunner } from "../../src/v4/quality/gate-runner";
import { AcceptanceEngine } from "../../src/v4/quality/acceptance-engine";
import { RepairPolicy } from "../../src/v4/quality/repair-policy";
import { QualityError } from "../../src/v4/quality/errors";
import {
  asGateId,
  asRequirementId,
  type GateDefinition,
  type RequirementRecord,
} from "../../src/v4/contracts/quality";
import { asEventId, asRunId, asStepId, type RunId } from "../../src/v4/contracts/ids";
import type { ProcessResult, ProcessRunner } from "../../src/v4/process/types";

async function transitionRunToVerify(events: FileEventStore, runId: RunId, tmpDir: string) {
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    },
    -1
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-1"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:01.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        phase: "INTAKE",
        sideEffect: "read-only",
        workspaceDir: tmpDir,
      },
    },
    0
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-2"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:02.000Z",
      type: "step.succeeded",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        result: {
          status: "succeeded",
          executionId: "op-1",
          summary: "intake complete",
          artifacts: [],
          evidence: [],
        },
      },
    },
    1
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-3"),
      runId,
      sequence: 3,
      at: "2026-08-20T10:00:03.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        from: "INTAKE",
        to: "PLAN",
        causedByEventId: asEventId("e-2"),
      },
    },
    2
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-4"),
      runId,
      sequence: 4,
      at: "2026-08-20T10:00:04.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-2"),
        operationId: "op-2",
        phase: "PLAN",
        sideEffect: "read-only",
        workspaceDir: tmpDir,
      },
    },
    3
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-5"),
      runId,
      sequence: 5,
      at: "2026-08-20T10:00:05.000Z",
      type: "step.succeeded",
      payload: {
        stepId: asStepId("s-2"),
        operationId: "op-2",
        result: {
          status: "succeeded",
          executionId: "op-2",
          summary: "plan complete",
          artifacts: [],
          evidence: [],
        },
      },
    },
    4
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-6"),
      runId,
      sequence: 6,
      at: "2026-08-20T10:00:06.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-2"),
        operationId: "op-2",
        from: "PLAN",
        to: "EXECUTE",
        causedByEventId: asEventId("e-5"),
      },
    },
    5
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-7"),
      runId,
      sequence: 7,
      at: "2026-08-20T10:00:07.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-3"),
        operationId: "op-3",
        phase: "EXECUTE",
        sideEffect: "workspace-write",
        workspaceDir: tmpDir,
      },
    },
    6
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-8"),
      runId,
      sequence: 8,
      at: "2026-08-20T10:00:08.000Z",
      type: "step.succeeded",
      payload: {
        stepId: asStepId("s-3"),
        operationId: "op-3",
        result: {
          status: "succeeded",
          executionId: "op-3",
          summary: "execute complete",
          artifacts: [],
          evidence: [],
        },
      },
    },
    7
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-9"),
      runId,
      sequence: 9,
      at: "2026-08-20T10:00:09.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-3"),
        operationId: "op-3",
        from: "EXECUTE",
        to: "VERIFY",
        causedByEventId: asEventId("e-8"),
      },
    },
    8
  );
}

test("quality_fault: gate process timeout gracefully reports inconclusive and triggers repair", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-fault-timeout-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-fault-1");
  await transitionRunToVerify(events, runId, tmpDir);

  const gateDef: GateDefinition = {
    id: asGateId("unit-test"),
    command: "npm",
    args: ["test"],
    cwd: ".",
    timeoutMs: 30000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "read-only",
    retrySafe: true,
  };

  const req: RequirementRecord = {
    requirementId: asRequirementId("R1"),
    text: "Unit tests pass",
    testStrategy: { kind: "hard", sourceText: "test: npm test" },
  };

  const registry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [gateDef],
    },
    [req]
  );

  const timeoutRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "",
        stderr: "Timed out",
        durationMs: 30000,
        termination: "timed-out",
        exitCode: null,
        signal: null,
      };
    },
  };

  const coordinator = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles,
    registry,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy({ maxRepairs: 2 }),
    processRunner: timeoutRunner,
  });

  const { decision, bundle } = await coordinator.runCycle(runId, "VERIFY", 0, 2);

  assert.equal(bundle?.gates[0]?.status, "inconclusive");
  assert.equal(bundle?.verdicts[0]?.status, "inconclusive");
  assert.equal(decision.kind, "repair");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("quality_fault: spawn error on missing binary cleanly marks inconclusive", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-fault-spawn-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-fault-2");
  await transitionRunToVerify(events, runId, tmpDir);

  const gateDef: GateDefinition = {
    id: asGateId("unit-test"),
    command: "nonexistent-binary",
    args: [],
    cwd: ".",
    timeoutMs: 30000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "read-only",
    retrySafe: true,
  };

  const req: RequirementRecord = {
    requirementId: asRequirementId("R1"),
    text: "Unit tests pass",
    testStrategy: { kind: "hard", sourceText: "test: npm test" },
  };

  const registry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [gateDef],
    },
    [req]
  );

  const spawnErrRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "",
        stderr: "",
        durationMs: 5,
        termination: "spawn-error",
        exitCode: null,
        signal: null,
        error: { code: "ENOENT", message: "spawn nonexistent-binary ENOENT" },
      };
    },
  };

  const coordinator = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles,
    registry,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy({ maxRepairs: 2 }),
    processRunner: spawnErrRunner,
  });

  const { decision, bundle } = await coordinator.runCycle(runId, "VERIFY", 0, 2);

  assert.equal(bundle?.gates[0]?.status, "inconclusive");
  assert.match(bundle?.gates[0]?.reason ?? "", /spawn/i);
  assert.equal(decision.kind, "repair");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("zero_false_green", async () => {
  // R46: Proves bundle write/rename/record/checksum failure yields zero false-green routes
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-fault-zero-green-"));
  const events = new FileEventStore({ projectDir: tmpDir });

  const runId = asRunId("run-fault-zero-green");
  await transitionRunToVerify(events, runId, tmpDir);

  const gateDef: GateDefinition = {
    id: asGateId("unit-test"),
    command: "npm",
    args: ["test"],
    cwd: ".",
    timeoutMs: 30000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "read-only",
    retrySafe: true,
  };

  const req: RequirementRecord = {
    requirementId: asRequirementId("R1"),
    text: "Unit tests pass",
    testStrategy: { kind: "hard", sourceText: "test: npm test" },
  };

  const registry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [gateDef],
    },
    [req]
  );

  const passingRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "PASS",
        stderr: "",
        durationMs: 10,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const faultClasses: Array<{
    name: string;
    customStore?: (root: string) => import("../../src/v4/quality/evidence-bundle-store").EvidenceBundleStorePort;
    fsHooks?: import("../../src/v4/quality/evidence-bundle-store").EvidenceBundleStoreFsHooks;
  }> = [
    {
      name: "temp bundle write failure",
      fsHooks: {
        beforeTempWrite: () => {
          throw new Error("Disk full ENOSPC during temp bundle write");
        },
      },
    },
    {
      name: "temp bundle fsync failure",
      fsHooks: {
        beforeTempSync: () => {
          throw new Error("I/O error EIO during temp bundle fsync");
        },
      },
    },
    {
      name: "bundle atomic rename failure",
      fsHooks: {
        beforeRename: () => {
          throw new Error("Permission denied EACCES during bundle atomic rename");
        },
      },
    },
    {
      name: "directory fsync real I/O failure",
      fsHooks: {
        beforeDirSync: () => {
          const err = new Error("Hard I/O error EIO during directory sync");
          (err as { code?: string }).code = "EIO";
          throw err;
        },
      },
    },
    {
      name: "record write failure",
      fsHooks: {
        beforeRecordWrite: () => {
          throw new Error("I/O failure during checksum record write");
        },
      },
    },
    {
      name: "record atomic rename failure",
      fsHooks: {
        beforeRecordRename: () => {
          throw new Error("I/O failure during checksum record rename");
        },
      },
    },
    {
      name: "read-back checksum mismatch",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async () => {
            throw new QualityError("GATE_EVIDENCE_INVALID", "Bundle checksum digest mismatch");
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
    {
      name: "read-back byte length mismatch",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async () => {
            throw new QualityError("GATE_EVIDENCE_INVALID", "Bundle byte length mismatch: expected 100, got 50");
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
    {
      name: "read-back missing record file",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async () => {
            throw new QualityError("GATE_EVIDENCE_INVALID", "Missing evidence bundle checksum record");
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
    {
      name: "read-back canonical content mismatch",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async (rId, cId) => {
            const actual = await realStore.readBundle(rId, cId);
            if (actual.routeIntent.kind !== "advance") {
              throw new Error("Expected advance routeIntent");
            }
            return {
              ...actual,
              routeIntent: {
                kind: "advance",
                from: actual.routeIntent.from,
                to: "DOCUMENT",
                causedByEventId: actual.routeIntent.causedByEventId,
              },
            };
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
    {
      name: "read-back altered causedByEventId",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async (rId, cId) => {
            const actual = await realStore.readBundle(rId, cId);
            return {
              ...actual,
              routeIntent: {
                ...actual.routeIntent,
                causedByEventId: asEventId("ev-forged-cause"),
              },
            };
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
    {
      name: "read-back altered decision",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async (rId, cId) => {
            const actual = await realStore.readBundle(rId, cId);
            return {
              ...actual,
              decision: {
                kind: "block",
                reason: "Forged block reason",
                requiredAction: "Action",
              },
            };
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
    {
      name: "read-back altered configHash",
      customStore: (root: string) => {
        const realStore = new EvidenceBundleStore({ projectRoot: root });
        return {
          writeBundle: (b) => realStore.writeBundle(b),
          readBundle: async (rId, cId) => {
            const actual = await realStore.readBundle(rId, cId);
            return {
              ...actual,
              configHash: "f".repeat(64),
            };
          },
          exportSummaryMarkdown: (b) => realStore.exportSummaryMarkdown(b),
        };
      },
    },
  ];

  for (let i = 0; i < faultClasses.length; i++) {
    const fault = faultClasses[i]!;
    const runIdFault = asRunId(`run-fault-${i}`);
    await transitionRunToVerify(events, runIdFault, tmpDir);

    const storeToUse = fault.customStore
      ? fault.customStore(tmpDir)
      : new EvidenceBundleStore({
          projectRoot: tmpDir,
          fsHooks: fault.fsHooks,
        });

    const coordinator = new QualityCoordinator({
      projectRoot: tmpDir,
      events,
      bundles: storeToUse,
      registry,
      gateRunner: new GateRunner(),
      acceptanceEngine: new AcceptanceEngine(),
      repairPolicy: new RepairPolicy({ maxRepairs: 2 }),
      processRunner: passingRunner,
    });

    const { decision } = await coordinator.runCycle(runIdFault, "VERIFY", 0, 2);

    assert.equal(decision.kind, "block", `Fault class '${fault.name}' must block run`);
    if (decision.kind === "block") {
      assert.match(decision.reason, /^GATE_EVIDENCE_INVALID:/, `Fault '${fault.name}' must have GATE_EVIDENCE_INVALID prefix`);
      assert.ok(decision.requiredAction.length > 0);
    }

    const history = await events.read(runIdFault);
    const routed = history.filter((e) => e.type === "run.routed");
    assert.equal(routed.length, 0, `Fault class '${fault.name}' must NEVER emit run.routed`);

    const blocked = history.find((e) => e.type === "run.blocked");
    assert.ok(blocked, `Fault class '${fault.name}' must emit run.blocked event`);
  }

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

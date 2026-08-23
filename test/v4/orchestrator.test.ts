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
import {
  asGateId,
  asRequirementId,
  type GateDefinition,
  type RequirementRecord,
} from "../../src/v4/contracts/quality";
import { asEventId, asRunId, asStepId, type RunId } from "../../src/v4/contracts/ids";
import type { ProcessResult, ProcessRunner } from "../../src/v4/process/types";

async function transitionRunToVerify(events: FileEventStore, runId: RunId, tmpDir: string) {
  // 0. run.created
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

  // 1-3. INTAKE -> PLAN
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

  // 4-6. PLAN -> EXECUTE
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

  // 7-9. EXECUTE -> VERIFY
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

test("quality_boundary", async () => {
  // R1: Quality execution is isolated; RunController does not directly run gate commands
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-boundary-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });
  const runId = asRunId("run-boundary-1");
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

  let runnerCalled = false;
  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      runnerCalled = true;
      return {
        stdout: "PASS",
        stderr: "",
        durationMs: 20,
        termination: "exited",
        exitCode: 0,
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
    processRunner: fakeRunner,
  });

  const { decision } = await coordinator.runCycle(runId, "VERIFY", 0, 2);
  assert.equal(runnerCalled, true, "GateRunner executes through coordinator dependency");
  assert.equal(decision.kind, "advance");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("verify_to_accept", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-v-to-a-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-v-to-a");
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

  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "PASS all tests",
        stderr: "",
        durationMs: 50,
        termination: "exited",
        exitCode: 0,
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
    processRunner: fakeRunner,
  });

  const { decision, bundle } = await coordinator.runCycle(runId, "VERIFY", 0, 2);

  assert.equal(decision.kind, "advance");
  if (decision.kind === "advance") {
    assert.equal(decision.to, "ACCEPT");
  }

  assert.equal(bundle?.gates[0]?.status, "passed");
  assert.equal(bundle?.verdicts[0]?.status, "accepted");

  // Read event history and verify sequence: quality.completed -> run.routed
  const history = await events.read(runId);
  const qcIndex = history.findIndex((e) => e.type === "quality.completed");
  const routedIndex = history.findIndex((e) => e.type === "run.routed");
  assert.ok(qcIndex >= 0 && routedIndex > qcIndex, "quality.completed must precede run.routed");

  const qcEvent = history[qcIndex]!;
  const routedEvent = history[routedIndex]!;
  if (routedEvent.type === "run.routed") {
    assert.equal(routedEvent.payload.from, "VERIFY");
    assert.equal(routedEvent.payload.to, "ACCEPT");
    assert.equal(routedEvent.payload.causedByEventId, qcEvent.eventId, "Advance route must cite quality.completed event");
  }

  // Verify bundle on disk
  const savedBundle = await bundles.readBundle(runId);
  assert.deepEqual(savedBundle, bundle);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("verify_to_fix", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-v-to-f-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-v-to-f");
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

  const failingRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "",
        stderr: "Tests failed!",
        durationMs: 50,
        termination: "exited",
        exitCode: 1,
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
    processRunner: failingRunner,
  });

  const { decision, bundle } = await coordinator.runCycle(runId, "VERIFY", 0, 2);

  assert.equal(decision.kind, "repair");
  if (decision.kind === "repair") {
    assert.equal(decision.to, "FIX");
    assert.deepEqual(decision.requirementIds, [asRequirementId("R1")]);
  }

  const history = await events.read(runId);
  const qcIndex = history.findIndex((e) => e.type === "quality.completed");
  const repIndex = history.findIndex((e) => e.type === "repair.decided");
  const routedIndex = history.findIndex((e) => e.type === "run.routed");
  assert.ok(qcIndex >= 0 && repIndex > qcIndex && routedIndex > repIndex, "Sequence must be quality.completed -> repair.decided -> run.routed");

  const repEvent = history[repIndex]!;
  const routedEvent = history[routedIndex]!;
  if (routedEvent.type === "run.routed") {
    assert.equal(routedEvent.payload.from, "VERIFY");
    assert.equal(routedEvent.payload.to, "FIX");
    assert.equal(routedEvent.payload.causedByEventId, repEvent.eventId, "Repair route must cite repair.decided event");
  }

  // Verify bundle on disk has repair routeIntent
  const savedBundle = await bundles.readBundle(runId);
  assert.deepEqual(savedBundle, bundle);
  assert.equal(savedBundle.routeIntent.kind, "repair");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("accept_to_document", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-a-to-d-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-a-to-d");
  await transitionRunToVerify(events, runId, tmpDir);

  const gateDef: GateDefinition = {
    id: asGateId("e2e-test"),
    command: "npm",
    args: ["test:e2e"],
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
    text: "E2E tests pass",
    testStrategy: { kind: "hard", sourceText: "test: npm test:e2e" },
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

  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "E2E PASS",
        stderr: "",
        durationMs: 100,
        termination: "exited",
        exitCode: 0,
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
    processRunner: fakeRunner,
  });

  const { decision, bundle } = await coordinator.runCycle(runId, "ACCEPT", 0, 2);
  assert.equal(decision.kind, "advance");
  if (decision.kind === "advance") {
    assert.equal(decision.to, "DOCUMENT");
  }

  const history = await events.read(runId);
  const qcIndex = history.findIndex((e) => e.type === "quality.completed");
  const routedIndex = history.findIndex((e) => e.type === "run.routed");
  assert.ok(qcIndex >= 0 && routedIndex > qcIndex);

  const qcEvent = history[qcIndex]!;
  const routedEvent = history[routedIndex]!;
  if (routedEvent.type === "run.routed") {
    assert.equal(routedEvent.payload.from, "ACCEPT");
    assert.equal(routedEvent.payload.to, "DOCUMENT");
    assert.equal(routedEvent.payload.causedByEventId, qcEvent.eventId);
  }

  const savedBundle = await bundles.readBundle(runId);
  assert.deepEqual(savedBundle, bundle);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("accept_to_rework", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-a-to-r-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-a-to-r");
  await transitionRunToVerify(events, runId, tmpDir);

  const gateDef: GateDefinition = {
    id: asGateId("e2e-test"),
    command: "npm",
    args: ["test:e2e"],
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
    text: "E2E tests pass",
    testStrategy: { kind: "hard", sourceText: "test: npm test:e2e" },
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

  const failingRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "",
        stderr: "E2E assertion failed",
        durationMs: 100,
        termination: "exited",
        exitCode: 1,
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
    processRunner: failingRunner,
  });

  const { decision, bundle } = await coordinator.runCycle(runId, "ACCEPT", 0, 2);
  assert.equal(decision.kind, "repair");
  if (decision.kind === "repair") {
    assert.equal(decision.to, "REWORK");
  }

  const history = await events.read(runId);
  const repIndex = history.findIndex((e) => e.type === "repair.decided");
  const routedIndex = history.findIndex((e) => e.type === "run.routed");
  assert.ok(repIndex >= 0 && routedIndex > repIndex);

  const repEvent = history[repIndex]!;
  const routedEvent = history[routedIndex]!;
  if (routedEvent.type === "run.routed") {
    assert.equal(routedEvent.payload.from, "ACCEPT");
    assert.equal(routedEvent.payload.to, "REWORK");
    assert.equal(routedEvent.payload.causedByEventId, repEvent.eventId);
  }

  const savedBundle = await bundles.readBundle(runId);
  assert.deepEqual(savedBundle, bundle);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("mandatory_inconclusive_blocks", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-inconcl-block-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-inconcl-block");
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
    repairPolicy: new RepairPolicy({ maxRepairs: 0 }), // 0 max repairs forces immediate block
    processRunner: timeoutRunner,
  });

  const { decision } = await coordinator.runCycle(runId, "VERIFY", 0, 0);
  assert.equal(decision.kind, "block");
  if (decision.kind === "block") {
    assert.ok(decision.requiredAction.length > 0, "Must provide actionable requiredAction");
  }

  const history = await events.read(runId);
  const qcIndex = history.findIndex((e) => e.type === "quality.completed");
  const blockedIndex = history.findIndex((e) => e.type === "run.blocked");
  assert.ok(qcIndex >= 0 && blockedIndex > qcIndex);

  const qcEvent = history[qcIndex]!;
  const blockedEvent = history[blockedIndex]!;
  if (blockedEvent.type === "run.blocked") {
    assert.ok(blockedEvent.payload.requiredAction.length > 0);
    assert.equal(blockedEvent.payload.causedByEventId, qcEvent.eventId);
  }

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileEventStore } from "../../src/v4/storage/event-store";
import { recoverRun } from "../../src/v4/core/recovery";
import {
  asEventId,
  asGateId,
  asQualityCycleId,
  asRequirementId,
  asRunId,
  asStepId,
  type GateDefinition,
  type RunEvent,
  type RunId,
} from "../../src/v4/contracts";
import { FakeAdapter } from "../../src/v4/testing/fake-adapter";
import { createDefaultPolicy } from "../../src/v4/policy/default-policy";
import { FileArtifactStore } from "../../src/v4/storage/artifact-store";
import { GateRegistry } from "../../src/v4/quality/gate-registry";
import { QualityCoordinator } from "../../src/v4/quality/quality-coordinator";
import { GateRunner } from "../../src/v4/quality/gate-runner";
import { AcceptanceEngine } from "../../src/v4/quality/acceptance-engine";
import { RepairPolicy } from "../../src/v4/quality/repair-policy";
import { EvidenceBundleStore } from "../../src/v4/quality/evidence-bundle-store";

async function setupVerifyRun(events: FileEventStore, runId: RunId, tmpDir: string) {
  const evs: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    },
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
  ];

  for (let i = 0; i < evs.length; i++) {
    await events.append(evs[i]!, i - 1);
  }
}

test("interrupted_cycle_not_passed", async () => {
  // R34: An interrupted quality cycle is never reused as a passed cycle
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-rec-r34-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const runId = asRunId("run-r34");
  await setupVerifyRun(events, runId, tmpDir);

  const cycleId = asQualityCycleId("cycle-interrupted-1");
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-10"),
      runId,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId,
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  // Partial gate started but crashed
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-11"),
      runId,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-gate-1",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const registry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [
        {
          id: asGateId("unit-test"),
          command: "node",
          args: ["-e", "process.exit(0)"],
          cwd: tmpDir,
          timeoutMs: 5000,
          mandatory: true,
          requirementIds: [asRequirementId("R1")],
          dependsOn: [],
          sideEffect: "read-only",
          retrySafe: true,
        },
      ],
    },
    [
      {
        requirementId: asRequirementId("R1"),
        text: "Sample req",
        testStrategy: { kind: "hard", sourceText: "test: npm test" },
      },
    ]
  );

  let eventSeq = 11;
  const deps = {
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events,
    artifacts: new FileArtifactStore(),
    now: () => "2026-08-20T10:00:12.000Z",
    newEventId: () => asEventId(`e-${++eventSeq}`),
    gateRegistry: registry,
  };

  const res = await recoverRun(deps, runId);
  // Must rerun, never claim passed/advance
  assert.equal(res.kind, "rerun");
  assert.equal(res.state.phase, "VERIFY");

  const history = await events.read(runId);
  assert.ok(
    history.some(
      (e) => e.type === "quality.started" && e.payload.cycleId === cycleId
    )
  );

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("resume_new_cycle", async () => {
  // R35: Resume starts a new mandatory verification cycle while preserving interrupted cycle
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-rec-r35-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });
  const runId = asRunId("run-r35");
  await setupVerifyRun(events, runId, tmpDir);

  const oldCycleId = asQualityCycleId("cycle-old");
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-10"),
      runId,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId: oldCycleId,
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-11"),
      runId,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId: oldCycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-gate-old",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const gateDef: GateDefinition = {
    id: asGateId("unit-test"),
    command: "node",
    args: ["-e", "process.exit(0)"],
    cwd: tmpDir,
    timeoutMs: 5000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "read-only",
    retrySafe: true,
  };
  const req = {
    requirementId: asRequirementId("R1"),
    text: "Sample req",
    testStrategy: { kind: "hard" as const, sourceText: "test: npm test" },
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

  let eventSeq = 11;
  const deps = {
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events,
    artifacts: new FileArtifactStore(),
    now: () => "2026-08-20T10:00:12.000Z",
    newEventId: () => asEventId(`e-${++eventSeq}`),
    gateRegistry: registry,
    bundles,
  };

  // 1. Must call recoverRun and obtain rerun directive
  const res = await recoverRun(deps, runId);
  assert.equal(res.kind, "rerun");
  assert.equal(res.state.phase, "VERIFY");

  // 2. Real coordinator executes fresh cycle
  const passingRunner = {
    run: async () => ({
      stdout: "PASS",
      stderr: "",
      durationMs: 10,
      termination: "exited" as const,
      exitCode: 0,
      signal: null,
    }),
  };

  const coordinator = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles,
    registry,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy(),
    processRunner: passingRunner,
  });

  const { decision } = await coordinator.runCycle(runId, "VERIFY", 0, 2);
  assert.equal(decision.kind, "advance");

  const history = await events.read(runId);
  const startedCycles = history.filter((e): e is RunEvent & { type: "quality.started" } => e.type === "quality.started");
  assert.equal(startedCycles.length, 2, "Must contain both old and new quality.started events");
  assert.notEqual(
    startedCycles[0]!.payload.cycleId,
    startedCycles[1]!.payload.cycleId,
    "New cycle must have fresh cycleId"
  );

  const gateStarts = history.filter((e): e is RunEvent & { type: "gate.started" } => e.type === "gate.started");
  assert.equal(gateStarts.length, 2);
  assert.equal(gateStarts[0]!.payload.operationId, "op-gate-old");
  assert.notEqual(gateStarts[1]!.payload.operationId, "op-gate-old", "Rerun must use fresh operation ID");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("reruns_read_only_gate", async () => {
  // R36: Interrupted read-only gates may be rerun with a fresh operation ID
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-rec-r36-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });
  const runId = asRunId("run-r36");
  await setupVerifyRun(events, runId, tmpDir);

  const cycleId = asQualityCycleId("cycle-1");
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-10"),
      runId,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId,
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-11"),
      runId,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId,
        gateId: asGateId("lint-gate"),
        operationId: "op-read-only-old",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const gateDef: GateDefinition = {
    id: asGateId("lint-gate"),
    command: "npm",
    args: ["run", "lint"],
    cwd: tmpDir,
    timeoutMs: 5000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "read-only",
    retrySafe: false, // read-only is always safe regardless of retrySafe
  };
  const req = {
    requirementId: asRequirementId("R1"),
    text: "Sample req",
    testStrategy: { kind: "hard" as const, sourceText: "test: npm run lint" },
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

  let eventSeq = 11;
  const deps = {
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events,
    artifacts: new FileArtifactStore(),
    now: () => "2026-08-20T10:00:12.000Z",
    newEventId: () => asEventId(`e-${++eventSeq}`),
    gateRegistry: registry,
    bundles,
  };

  const res = await recoverRun(deps, runId);
  assert.equal(res.kind, "rerun");
  assert.equal(res.state.phase, "VERIFY");
  assert.equal(res.previousOperationId, "op-read-only-old");

  // Real rerun via coordinator completes and uses fresh operation ID
  const coordinator = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles,
    registry,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy(),
    processRunner: {
      run: async () => ({
        stdout: "LINT OK",
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      }),
    },
  });

  const { decision } = await coordinator.runCycle(runId, "VERIFY", 0, 2);
  assert.equal(decision.kind, "advance");

  const history = await events.read(runId);
  const gateStarts = history.filter((e): e is RunEvent & { type: "gate.started" } => e.type === "gate.started");
  assert.equal(gateStarts.length, 2);
  assert.notEqual(gateStarts[1]!.payload.operationId, "op-read-only-old");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("workspace_write_retry_policy", async () => {
  // R37: Interrupted workspace-write gates rerun only when retrySafe is true
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-rec-r37-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  // Subcase A: retrySafe === true -> rerun
  const runIdSafe = asRunId("run-r37-safe");
  await setupVerifyRun(events, runIdSafe, tmpDir);

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-10"),
      runId: runIdSafe,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId: asQualityCycleId("c-1"),
        phase: "ACCEPT",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-11"),
      runId: runIdSafe,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId: asQualityCycleId("c-1"),
        gateId: asGateId("write-safe-gate"),
        operationId: "op-w1",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const writeSafeGate: GateDefinition = {
    id: asGateId("write-safe-gate"),
    command: "npm",
    args: ["run", "gen"],
    cwd: tmpDir,
    timeoutMs: 5000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "workspace-write",
    retrySafe: true,
  };
  const reqWriteSafe = {
    requirementId: asRequirementId("R1"),
    text: "Sample req",
    testStrategy: { kind: "hard" as const, sourceText: "test: npm run gen" },
  };
  const registrySafe = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [writeSafeGate],
    },
    [reqWriteSafe]
  );

  let eventSeq = 11;
  const depsSafe = {
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events,
    artifacts: new FileArtifactStore(),
    now: () => "2026-08-20T10:00:12.000Z",
    newEventId: () => asEventId(`e-${++eventSeq}`),
    gateRegistry: registrySafe,
    bundles,
  };

  const resSafe = await recoverRun(depsSafe, runIdSafe);
  assert.equal(resSafe.kind, "rerun");

  // Execute rerun for safe gate
  const coordinatorSafe = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles,
    registry: registrySafe,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy(),
    processRunner: {
      run: async () => ({
        stdout: "GEN OK",
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      }),
    },
  });
  const { decision: decSafe } = await coordinatorSafe.runCycle(runIdSafe, "ACCEPT", 0, 2);
  assert.equal(decSafe.kind, "advance");

  // Subcase B: retrySafe === false -> blocks with QUALITY_RECOVERY_UNSAFE
  const runIdUnsafe = asRunId("run-r37-unsafe");
  await setupVerifyRun(events, runIdUnsafe, tmpDir);

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-20"),
      runId: runIdUnsafe,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId: asQualityCycleId("c-1"),
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-21"),
      runId: runIdUnsafe,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId: asQualityCycleId("c-1"),
        gateId: asGateId("write-unsafe-gate"),
        operationId: "op-w2",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const writeUnsafeGate: GateDefinition = {
    id: asGateId("write-unsafe-gate"),
    command: "npm",
    args: ["run", "mutate"],
    cwd: tmpDir,
    timeoutMs: 5000,
    mandatory: true,
    requirementIds: [asRequirementId("R1")],
    dependsOn: [],
    sideEffect: "workspace-write",
    retrySafe: false,
  };
  const reqWriteUnsafe = {
    requirementId: asRequirementId("R1"),
    text: "Sample req",
    testStrategy: { kind: "hard" as const, sourceText: "test: npm run mutate" },
  };
  const registryUnsafe = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [writeUnsafeGate],
    },
    [reqWriteUnsafe]
  );

  const depsUnsafe = {
    ...depsSafe,
    gateRegistry: registryUnsafe,
  };

  const resUnsafe = await recoverRun(depsUnsafe, runIdUnsafe);
  assert.equal(resUnsafe.kind, "blocked");
  if (resUnsafe.kind === "blocked") {
    assert.match(resUnsafe.reason, /QUALITY_RECOVERY_UNSAFE/);
    assert.match(resUnsafe.reason, /not retry-safe/);
  }

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("ambiguous_recovery_blocks", async () => {
  // R38: Missing or ambiguous recovery correlation blocks with QUALITY_RECOVERY_UNSAFE
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-rec-r38-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });

  // Subcase A: Missing gate registry entirely when recovering in-flight gate
  const runIdNoReg = asRunId("run-r38-no-reg");
  await setupVerifyRun(events, runIdNoReg, tmpDir);
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-10"),
      runId: runIdNoReg,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId: asQualityCycleId("cycle-1"),
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-11"),
      runId: runIdNoReg,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId: asQualityCycleId("cycle-1"),
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  let eventSeq = 11;
  const depsNoReg = {
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events,
    artifacts: new FileArtifactStore(),
    now: () => "2026-08-20T10:00:12.000Z",
    newEventId: () => asEventId(`e-${++eventSeq}`),
    bundles,
  };

  const resNoReg = await recoverRun(depsNoReg, runIdNoReg);
  assert.equal(resNoReg.kind, "blocked");
  if (resNoReg.kind === "blocked") {
    assert.match(resNoReg.reason, /QUALITY_RECOVERY_UNSAFE/);
    assert.match(resNoReg.reason, /registry is required/i);
  }

  // Subcase B: Cross-cycle / mismatched cycle ID correlation
  const runIdAmbiguous = asRunId("run-r38-ambiguous");
  await setupVerifyRun(events, runIdAmbiguous, tmpDir);

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-30"),
      runId: runIdAmbiguous,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId: asQualityCycleId("cycle-A"),
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-31"),
      runId: runIdAmbiguous,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId: asQualityCycleId("cycle-B-corrupted"), // Mismatched cycle ID!
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const registry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [
        {
          id: asGateId("unit-test"),
          command: "node",
          args: ["-e", "process.exit(0)"],
          cwd: tmpDir,
          timeoutMs: 5000,
          mandatory: true,
          requirementIds: [asRequirementId("R1")],
          dependsOn: [],
          sideEffect: "read-only",
          retrySafe: true,
        },
      ],
    },
    [
      {
        requirementId: asRequirementId("R1"),
        text: "Req",
        testStrategy: { kind: "hard", sourceText: "test: node" },
      },
    ]
  );

  const depsWithReg = {
    ...depsNoReg,
    gateRegistry: registry,
  };

  const resAmbiguous = await recoverRun(depsWithReg, runIdAmbiguous);
  assert.equal(resAmbiguous.kind, "blocked");
  if (resAmbiguous.kind === "blocked") {
    assert.match(resAmbiguous.reason, /QUALITY_RECOVERY_UNSAFE/);
    assert.match(resAmbiguous.reason, /Ambiguous quality cycle/);
  }

  // Subcase C: Missing or corrupt evidence bundle on roll-forward
  const runIdCorruptBundle = asRunId("run-r38-corrupt-bundle");
  await setupVerifyRun(events, runIdCorruptBundle, tmpDir);

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-40"),
      runId: runIdCorruptBundle,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId: asQualityCycleId("cycle-1"),
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-41"),
      runId: runIdCorruptBundle,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "quality.completed",
      payload: {
        cycleId: asQualityCycleId("cycle-1"),
        decision: { kind: "advance", to: "ACCEPT" },
        completedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    10
  );

  const mockFailingStore = {
    writeBundle: async () => { throw new Error("not implemented"); },
    readBundle: async () => { throw new Error("Checksum record corrupted"); },
    exportSummaryMarkdown: () => "",
  };

  // Subcase D: Tampered routeIntent to/reason/action/cause semantic mismatch on quality.completed
  const runIdTampered = asRunId("run-r38-tampered");
  await setupVerifyRun(events, runIdTampered, tmpDir);

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-50"),
      runId: runIdTampered,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.completed",
      payload: {
        cycleId: asQualityCycleId("cycle-tamper"),
        decision: { kind: "advance", to: "ACCEPT" },
        completedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  const mockTamperedStore = {
    writeBundle: async () => { throw new Error("not implemented"); },
    readBundle: async () => ({
      schemaVersion: 1 as const,
      runId: runIdTampered,
      cycleId: asQualityCycleId("cycle-tamper"),
      phase: "VERIFY" as const,
      configHash: "abc",
      requirementsHash: "def",
      generatedAt: "2026-08-20T10:00:10.000Z",
      gates: [],
      evidence: [],
      verdicts: [],
      repairHistory: [],
      decision: { kind: "advance" as const, to: "ACCEPT" as const },
      routeIntent: {
        kind: "advance" as const,
        from: "VERIFY" as const,
        to: "DOCUMENT" as const, // TAMPERED target!
        causedByEventId: asEventId("e-50"),
      },
    }),
    exportSummaryMarkdown: () => "",
  };

  const depsTampered = {
    ...depsWithReg,
    bundles: mockTamperedStore,
  };

  const resTampered = await recoverRun(depsTampered, runIdTampered);
  assert.equal(resTampered.kind, "blocked");
  if (resTampered.kind === "blocked") {
    assert.match(resTampered.reason, /QUALITY_RECOVERY_UNSAFE/);
    assert.match(resTampered.reason, /semantic mismatch/i);
  }

  // Subcase E: quality.completed with repair decision without repair.decided event -> blocks
  const runIdRepairNoEvent = asRunId("run-r38-rep-no-ev");
  await setupVerifyRun(events, runIdRepairNoEvent, tmpDir);
  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-60"),
      runId: runIdRepairNoEvent,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.completed",
      payload: {
        cycleId: asQualityCycleId("cycle-rep"),
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        completedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  const mockValidRepairStore = {
    writeBundle: async () => { throw new Error("not implemented"); },
    readBundle: async () => ({
      schemaVersion: 1 as const,
      runId: runIdRepairNoEvent,
      cycleId: asQualityCycleId("cycle-rep"),
      phase: "VERIFY" as const,
      configHash: "abc",
      requirementsHash: "def",
      generatedAt: "2026-08-20T10:00:10.000Z",
      gates: [],
      evidence: [],
      verdicts: [],
      repairHistory: [],
      decision: { kind: "repair" as const, to: "FIX" as const, requirementIds: [asRequirementId("R1")] },
      routeIntent: {
        kind: "repair" as const,
        from: "VERIFY" as const,
        to: "FIX" as const,
        requirementIds: [asRequirementId("R1")],
        attempt: 1,
        causedByEventId: asEventId("e-60"),
      },
    }),
    exportSummaryMarkdown: () => "",
  };

  const resRepairNoEv = await recoverRun({ ...depsWithReg, bundles: mockValidRepairStore }, runIdRepairNoEvent);
  assert.equal(resRepairNoEv.kind, "blocked");
  if (resRepairNoEv.kind === "blocked") {
    assert.match(resRepairNoEv.reason, /QUALITY_RECOVERY_UNSAFE/);
    assert.match(resRepairNoEv.reason, /repair\.decided event was not durably recorded/i);
  }

  // Subcase F: Corrupted expected prior bundle fails closed in QualityCoordinator and does not reset history
  const runIdCorruptPrior = asRunId("run-r38-corrupt-prior");
  await setupVerifyRun(events, runIdCorruptPrior, tmpDir);

  await events.append(
    {
      schemaVersion: 1,
      eventId: asEventId("e-70"),
      runId: runIdCorruptPrior,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.completed",
      payload: {
        cycleId: asQualityCycleId("cycle-prior-completed"),
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        completedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    9
  );

  let processRunnerCallCount = 0;
  const failingCoordinator = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles: mockFailingStore, // Bundle reading throws corruption error!
    registry,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy(),
    processRunner: {
      run: async () => {
        processRunnerCallCount++;
        return {
          stdout: "",
          stderr: "",
          durationMs: 10,
          termination: "exited" as const,
          exitCode: 0,
          signal: null,
        };
      },
    },
  });

  const failResult = await failingCoordinator.runCycle(runIdCorruptPrior, "VERIFY", 0, 2);
  assert.equal(failResult.decision.kind, "block");
  assert.match(failResult.decision.reason, /GATE_EVIDENCE_INVALID/);
  assert.match(failResult.decision.reason, /Failed to read prior authorized quality cycle bundle/);
  assert.equal(processRunnerCallCount, 0, "ProcessRunner must NOT be invoked when prior bundle is corrupted");

  // Subcase G: Agent judge operationId includes fresh cycleId and differs across cycles
  let capturedOpIds: string[] = [];
  const mockJudge = {
    judgeRequirement: async (_req: unknown, ctx: { operationId: string; cycleId: string }) => {
      capturedOpIds.push(ctx.operationId);
      return {
        status: "inconclusive" as const,
        evidenceIds: [],
        rationale: "Agent evaluation inconclusive",
      };
    },
  };

  const agentReq = {
    requirementId: asRequirementId("R1"),
    text: "Agent req",
    testStrategy: { kind: "agent" as const, prompt: "Verify agent req" },
  };
  const agentRegistry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      outputSummaryBytes: 16384,
      gates: [],
    },
    [agentReq]
  );

  const realBundles = new EvidenceBundleStore({ projectRoot: tmpDir });
  const judgeCoordinator = new QualityCoordinator({
    projectRoot: tmpDir,
    events,
    bundles: realBundles,
    registry: agentRegistry,
    gateRunner: new GateRunner(),
    acceptanceEngine: new AcceptanceEngine(),
    repairPolicy: new RepairPolicy(),
    adapter: new FakeAdapter({ outcomes: [] }),
    agentJudge: mockJudge,
    processRunner: {
      run: async () => ({
        stdout: "",
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      }),
    },
  });

  const runIdJudge = asRunId("run-r38-judge");
  await setupVerifyRun(events, runIdJudge, tmpDir);

  await judgeCoordinator.runCycle(runIdJudge, "ACCEPT", 0, 2);
  await judgeCoordinator.runCycle(runIdJudge, "ACCEPT", 0, 2);

  assert.equal(capturedOpIds.length, 2);
  assert.notEqual(capturedOpIds[0], capturedOpIds[1], "Judge operation IDs must differ between cycles");
  assert.match(capturedOpIds[0]!, /judge-op-/);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

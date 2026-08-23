import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  validateGateDag,
  GateScheduler,
} from "../../src/v4/quality/gate-scheduler";
import {
  asGateId,
  asQualityCycleId,
  asRequirementId,
  type GateDefinition,
  type GateResult,
  type QualityEvidence,
  type RequirementRecord,
  type RequirementVerdict,
} from "../../src/v4/contracts/quality";
import { asRunId, asStepId, asEventId, asArtifactId } from "../../src/v4/contracts/ids";
import { QualityError } from "../../src/v4/quality/errors";
import { GateRunner } from "../../src/v4/quality/gate-runner";
import { RunOrchestrator } from "../../src/v4/orchestration/run-orchestrator";
import { RunController } from "../../src/v4/core/controller";
import { QualityCoordinator } from "../../src/v4/quality/quality-coordinator";
import { GateRegistry } from "../../src/v4/quality/gate-registry";
import { AcceptanceEngine } from "../../src/v4/quality/acceptance-engine";
import { RepairPolicy } from "../../src/v4/quality/repair-policy";
import { EvidenceBundleStore, type EvidenceBundle } from "../../src/v4/quality/evidence-bundle-store";
import { FileEventStore } from "../../src/v4/storage/event-store";
import { FileArtifactStore } from "../../src/v4/storage/artifact-store";
import { createDefaultPolicy } from "../../src/v4/policy/default-policy";
import { FakeAdapter } from "../../src/v4/testing/fake-adapter";
import type { ProcessResult, ProcessRunner } from "../../src/v4/process/types";
import type { AgentAdapter, StepRequest } from "../../src/v4/contracts/adapter";
import type { RunState } from "../../src/v4/contracts/run";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

function makeGate(
  id: string,
  dependsOn: string[] = [],
  sideEffect: "read-only" | "workspace-write" = "read-only",
  concurrencyKey?: string
): GateDefinition {
  return {
    id: asGateId(id),
    command: "npm",
    args: ["test", id],
    cwd: ".",
    timeoutMs: 30000,
    mandatory: true,
    requirementIds: [asRequirementId(`R-${id}`)],
    dependsOn: dependsOn.map(asGateId),
    sideEffect,
    retrySafe: true,
    concurrencyKey,
  };
}

class ControlledProcessRunner implements ProcessRunner {
  readonly activeGateIds: string[] = [];
  readonly startOrder: string[] = [];
  readonly finishOrder: string[] = [];
  peakConcurrency = 0;

  private readonly deferreds = new Map<
    string,
    { resolve: (res: ProcessResult) => void; reject: (err: unknown) => void }
  >();

  async run(options: { command: string; args: readonly string[]; cwd: string }): Promise<ProcessResult> {
    const gateId = options.args[1] ?? options.command;
    this.startOrder.push(gateId);
    this.activeGateIds.push(gateId);
    if (this.activeGateIds.length > this.peakConcurrency) {
      this.peakConcurrency = this.activeGateIds.length;
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      this.deferreds.set(gateId, {
        resolve: (res) => {
          const idx = this.activeGateIds.indexOf(gateId);
          if (idx !== -1) {
            this.activeGateIds.splice(idx, 1);
          }
          this.finishOrder.push(gateId);
          resolve(res);
        },
        reject,
      });
    });
  }

  releaseGate(gateId: string, exitCode = 0, stdout = "OK", stderr = ""): void {
    const d = this.deferreds.get(gateId);
    if (!d) {
      throw new Error(`Gate '${gateId}' is not active to release`);
    }
    d.resolve({
      stdout,
      stderr,
      durationMs: 50,
      termination: "exited",
      exitCode,
      signal: null,
    });
  }

  hasActive(gateId: string): boolean {
    return this.activeGateIds.includes(gateId);
  }
}

test("agent_steps_remain_serial", async () => {
  // R47: Only quality gates may execute concurrently; agent steps remain single in-flight across the run
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-serial-agent-"));
  const events = new FileEventStore({ projectDir: tmpDir });
  const artifacts = new FileArtifactStore();
  const policy = createDefaultPolicy();
  const runId = asRunId("run-serial-agent");

  let concurrentAgentSteps = 0;
  let maxConcurrentAgentSteps = 0;
  let totalAgentExecutions = 0;

  const trackingAdapter: AgentAdapter = {
    id: "tracking-adapter",
    probe: async () => ({
      available: true,
      adapterId: "tracking-adapter",
      capabilities: ["workspace.read", "workspace.write", "structured-output"],
      diagnostics: [],
    }),
    cancel: async () => {},
    execute: async (request) => {
      concurrentAgentSteps++;
      totalAgentExecutions++;
      if (concurrentAgentSteps > maxConcurrentAgentSteps) {
        maxConcurrentAgentSteps = concurrentAgentSteps;
      }
      await new Promise((r) => setTimeout(r, 20));
      concurrentAgentSteps--;
      await fs.writeFile(path.join(tmpDir, `out-${request.phase.toLowerCase()}.txt`), "ok", "utf-8");
      return {
        status: "succeeded",
        executionId: request.operationId,
        summary: `Executed ${request.phase}`,
        artifacts: [
          {
            artifactId: asArtifactId(`art-${request.stepId}`),
            kind: "file",
            relativePath: `out-${request.phase.toLowerCase()}.txt`,
          },
        ],
        evidence: [
          {
            schemaVersion: 1,
            kind: "artifact",
            producerStepId: request.stepId,
            method: "file-write",
            startedAt: "2026-08-20T10:00:00.000Z",
            durationMs: 10,
            artifactIds: [asArtifactId(`art-${request.stepId}`)],
            summary: "Wrote artifact",
          },
        ],
        native: {
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            costUsd: 0.001,
          },
        },
      };
    },
  };

  const sdlcDir = path.join(tmpDir, ".omni", "sdlc");
  await fs.mkdir(sdlcDir, { recursive: true });
  await fs.writeFile(
    path.join(sdlcDir, "requirements.md"),
    `- [ ] R1 | Req | test: quick-gate\n`,
    "utf-8"
  );

  const omniDir = path.join(tmpDir, ".omni", "v4");
  await fs.mkdir(omniDir, { recursive: true });
  await fs.writeFile(
    path.join(omniDir, "quality.json"),
    JSON.stringify({
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      outputSummaryBytes: 16384,
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 2,
      gates: [
        {
          id: "quick-gate",
          command: "node",
          args: ["-e", "process.exit(0)"],
          cwd: ".",
          timeoutMs: 5000,
          mandatory: true,
          requirementIds: ["R1"],
          dependsOn: [],
          sideEffect: "read-only",
          retrySafe: true,
        },
      ],
    }),
    "utf-8"
  );

  let eventSeq = 0;
  const controller = new RunController({
    adapter: trackingAdapter,
    policy,
    events,
    artifacts,
    now: () => "2026-08-20T10:00:00.000Z",
    newEventId: () => asEventId(`ev-${++eventSeq}`),
  });

  await controller.start({
    runId,
  });

  const gateDef: GateDefinition = {
    id: asGateId("quick-gate"),
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
  const registry = new GateRegistry(
    {
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      maxRepairAttemptsPerRequirement: 2,
      maxParallelGates: 4,
      outputSummaryBytes: 16384,
      gates: [gateDef],
    },
    [{ requirementId: asRequirementId("R1"), text: "Req", testStrategy: { kind: "hard", sourceText: "test" } }]
  );

  const bundles = new EvidenceBundleStore({ projectRoot: tmpDir });
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
        stdout: "PASS",
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      }),
    },
  });

  const orchestrator = new RunOrchestrator({
    controller,
    coordinator,
  });

  let stepCount = 0;
  const stepSupplier = async (state: RunState): Promise<StepRequest | undefined> => {
    stepCount++;
    if (state.phase === "INTAKE") {
      return {
        runId,
        stepId: asStepId(`step-${stepCount}`),
        phase: "INTAKE",
        operationId: `op-${stepCount}`,
        workspaceDir: tmpDir,
        prompt: "Intake spec",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read-only",
        timeoutMs: 5000,
      };
    }
    if (state.phase === "PLAN") {
      return {
        runId,
        stepId: asStepId(`step-${stepCount}`),
        phase: "PLAN",
        operationId: `op-${stepCount}`,
        workspaceDir: tmpDir,
        prompt: "Create plan",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read-only",
        timeoutMs: 5000,
      };
    }
    if (state.phase === "EXECUTE") {
      return {
        runId,
        stepId: asStepId(`step-${stepCount}`),
        phase: "EXECUTE",
        operationId: `op-${stepCount}`,
        workspaceDir: tmpDir,
        prompt: "Implement code",
        requiredCapabilities: ["workspace.write"],
        sideEffect: "workspace-write",
        timeoutMs: 5000,
      };
    }
    if (state.phase === "DOCUMENT") {
      return {
        runId,
        stepId: asStepId(`step-${stepCount}`),
        phase: "DOCUMENT",
        operationId: `op-${stepCount}`,
        workspaceDir: tmpDir,
        prompt: "Document results",
        requiredCapabilities: ["workspace.write"],
        sideEffect: "workspace-write",
        timeoutMs: 5000,
      };
    }
    return undefined;
  };

  const result = await orchestrator.runUntilTerminal(runId, stepSupplier);
  assert.equal(maxConcurrentAgentSteps, 1, "Agent execution steps must remain strictly single in-flight (max 1)");
  assert.ok(
    totalAgentExecutions >= 2,
    `Expected at least 2 agent executions sequentially, got ${totalAgentExecutions}`
  );
  assert.ok(
    result.finalState.phase === "ACCEPT" || result.finalState.phase === "DOCUMENT" || result.finalState.phase === "READY"
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("rejects_invalid_dag_references", () => {
  // R50: Duplicate gate IDs and missing dependencies are rejected before any gate starts
  assert.throws(
    () => validateGateDag([makeGate("A", ["B"])]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_INVALID"
  );
  assert.throws(
    () => validateGateDag([makeGate("A", ["A"])]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_INVALID"
  );
  assert.throws(
    () => validateGateDag([makeGate("B"), makeGate("A", ["B", "B"])]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_INVALID"
  );
  assert.throws(
    () => validateGateDag([makeGate("A"), makeGate("A")]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_INVALID"
  );
  assert.throws(
    () => validateGateDag([makeGate("A", [], "read-only", "   ")]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_INVALID"
  );
});

test("rejects_cycle", () => {
  // R51: Dependency cycles are rejected with GATE_DEPENDENCY_CYCLE
  assert.throws(
    () => validateGateDag([makeGate("A", ["B"]), makeGate("B", ["A"])]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_CYCLE"
  );
  assert.throws(
    () =>
      validateGateDag([
        makeGate("A", ["B"]),
        makeGate("B", ["C"]),
        makeGate("C", ["A"]),
      ]),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_DEPENDENCY_CYCLE"
  );
});

test("dependency_order", async () => {
  // R52: A gate starts only after every dependency has passed
  const runner = new ControlledProcessRunner();
  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 4 });

  const gates = [
    makeGate("A"),
    makeGate("B", ["A"]),
    makeGate("C", ["B"]),
  ];

  const schedulePromise = scheduler.schedule(gates, {
    runId: asRunId("run-dep-order"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("A"), true);
  assert.equal(runner.hasActive("B"), false);
  assert.equal(runner.hasActive("C"), false);

  runner.releaseGate("A", 0);
  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("B"), true);
  assert.equal(runner.hasActive("C"), false);

  runner.releaseGate("B", 0);
  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("C"), true);
  runner.releaseGate("C", 0);

  const res = await schedulePromise;
  assert.equal(res.results.get(asGateId("A"))?.status, "passed");
  assert.equal(res.results.get(asGateId("B"))?.status, "passed");
  assert.equal(res.results.get(asGateId("C"))?.status, "passed");
  assert.deepEqual(runner.startOrder, ["A", "B", "C"]);
});

test("parallel_independent_read_only", async () => {
  // R53: Independent read-only gates with non-conflicting concurrency keys may run in parallel
  const runner = new ControlledProcessRunner();
  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 2 });

  const gates = [makeGate("g1"), makeGate("g2"), makeGate("g3")];

  const schedulePromise = scheduler.schedule(gates, {
    runId: asRunId("run-sched-1"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("g1"), true);
  assert.equal(runner.hasActive("g2"), true);
  assert.equal(runner.hasActive("g3"), false); // Capped at 2

  runner.releaseGate("g1", 0);
  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("g3"), true);

  runner.releaseGate("g2", 0);
  runner.releaseGate("g3", 0);

  const res = await schedulePromise;
  assert.equal(res.peakParallelism, 2);
  assert.equal(res.results.get(asGateId("g1"))?.status, "passed");
  assert.equal(res.results.get(asGateId("g2"))?.status, "passed");
  assert.equal(res.results.get(asGateId("g3"))?.status, "passed");
});

test("concurrency_key_lock", async () => {
  // R54: Conflicting concurrency keys never overlap
  const runner = new ControlledProcessRunner();
  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 4 });

  const gates = [
    makeGate("g1", [], "read-only", "db-lock"),
    makeGate("g2", [], "read-only", "db-lock"),
    makeGate("g3", [], "read-only", "other-lock"),
  ];

  const schedulePromise = scheduler.schedule(gates, {
    runId: asRunId("run-sched-2"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("g1"), true);
  assert.equal(runner.hasActive("g3"), true);
  assert.equal(runner.hasActive("g2"), false);

  runner.releaseGate("g1", 0);
  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("g2"), true);

  runner.releaseGate("g2", 0);
  runner.releaseGate("g3", 0);

  const res = await schedulePromise;
  assert.equal(res.results.get(asGateId("g2"))?.status, "passed");
});

test("workspace_write_exclusive", async () => {
  // R55: A workspace-write gate holds an exclusive workspace lock
  const runner = new ControlledProcessRunner();
  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 4 });

  const gates = [
    makeGate("read-1", [], "read-only"),
    makeGate("write-1", [], "workspace-write"),
    makeGate("read-2", [], "read-only"),
  ];

  const schedulePromise = scheduler.schedule(gates, {
    runId: asRunId("run-sched-3"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("read-1"), true);
  assert.equal(runner.hasActive("write-1"), false);
  assert.equal(runner.hasActive("read-2"), true);

  runner.releaseGate("read-1", 0);
  runner.releaseGate("read-2", 0);
  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("write-1"), true);
  assert.equal(runner.activeGateIds.length, 1);

  runner.releaseGate("write-1", 0);

  const res = await schedulePromise;
  assert.equal(res.results.get(asGateId("write-1"))?.status, "passed");
});

test("active_gates_finish", async () => {
  // R56: Gates already running may finish after another gate fails
  const runner = new ControlledProcessRunner();
  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 3 });

  const gates = [
    makeGate("failing-independent"),
    makeGate("slow-independent"),
    makeGate("dependent-on-failing", ["failing-independent"]),
  ];

  const schedulePromise = scheduler.schedule(gates, {
    runId: asRunId("run-active-finish"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("failing-independent"), true);
  assert.equal(runner.hasActive("slow-independent"), true);
  assert.equal(runner.hasActive("dependent-on-failing"), false);

  // failing-independent fails immediately
  runner.releaseGate("failing-independent", 1, "", "Failed tests");
  await setImmediate();
  await setImmediate();

  // slow-independent was already active and MUST still be active, not aborted
  assert.equal(runner.hasActive("slow-independent"), true);
  assert.equal(runner.hasActive("dependent-on-failing"), false);

  // Release slow-independent successfully
  runner.releaseGate("slow-independent", 0, "Slow passed");

  const res = await schedulePromise;
  assert.equal(res.results.get(asGateId("failing-independent"))?.status, "failed");
  assert.equal(res.results.get(asGateId("slow-independent"))?.status, "passed");
  assert.equal(res.results.get(asGateId("dependent-on-failing"))?.status, "inconclusive");
});

test("failed_dependency_prevents_start", async () => {
  // R57: A gate whose dependency failed does not start and receives an explicit non-pass reason
  const runner = new ControlledProcessRunner();
  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 2 });

  const gates = [
    makeGate("parent"),
    makeGate("child", ["parent"]),
  ];

  const schedulePromise = scheduler.schedule(gates, {
    runId: asRunId("run-sched-4"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  await setImmediate();
  await setImmediate();

  assert.equal(runner.hasActive("parent"), true);
  assert.equal(runner.hasActive("child"), false);

  runner.releaseGate("parent", 1, "", "Failed tests");

  const res = await schedulePromise;
  assert.equal(res.results.get(asGateId("parent"))?.status, "failed");
  assert.equal(res.results.get(asGateId("child"))?.status, "inconclusive"); // mandatory child
  assert.equal(runner.startOrder.includes("child"), false);
  assert.match(res.results.get(asGateId("child"))?.reason ?? "", /Dependency gate 'parent' did not pass/i);
});

test("parallel_sequential_equivalence", async () => {
  // R58: Parallel and sequential execution of the same fixture produce identical acceptance verdicts and evidence mapping
  const req1: RequirementRecord = {
    requirementId: asRequirementId("R-gate-A"),
    text: "Req A",
    testStrategy: { kind: "hard", sourceText: "test" },
  };
  const req2: RequirementRecord = {
    requirementId: asRequirementId("R-gate-B"),
    text: "Req B",
    testStrategy: { kind: "hard", sourceText: "test" },
  };
  const req3: RequirementRecord = {
    requirementId: asRequirementId("R-gate-C"),
    text: "Req C",
    testStrategy: { kind: "hard", sourceText: "test" },
  };
  const requirements = [req1, req2, req3];

  const gateA = makeGate("gate-A");
  const gateB = makeGate("gate-B");
  const gateC = makeGate("gate-C", ["gate-A"]);
  const gates = [gateA, gateB, gateC];

  const deterministicRunner: ProcessRunner = {
    run: async (options: { command: string; args: readonly string[]; cwd: string }) => {
      const gateId = options.args[1] ?? options.command;
      return {
        stdout: `OUTPUT for ${gateId}`,
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const acceptanceEngine = new AcceptanceEngine();
  const store = new EvidenceBundleStore({ projectRoot: "." });

  const schedSequential = new GateScheduler({ maxParallelGates: 1 });
  const schedParallel = new GateScheduler({ maxParallelGates: 4 });

  const seqRunId = asRunId("run-equiv-1");
  const seqCycleId = asQualityCycleId("cycle-1");
  const seqRes = await schedSequential.schedule(gates, {
    runId: seqRunId,
    cycleId: seqCycleId,
    projectRoot: ".",
    runner: deterministicRunner,
    gateRunner,
  });

  const parRunId = asRunId("run-equiv-2");
  const parCycleId = asQualityCycleId("cycle-2");
  const parRes = await schedParallel.schedule(gates, {
    runId: parRunId,
    cycleId: parCycleId,
    projectRoot: ".",
    runner: deterministicRunner,
    gateRunner,
  });

  // Verify declaration ordering in both
  assert.deepEqual(Array.from(seqRes.results.keys()), [asGateId("gate-A"), asGateId("gate-B"), asGateId("gate-C")]);
  assert.deepEqual(Array.from(parRes.results.keys()), [asGateId("gate-A"), asGateId("gate-B"), asGateId("gate-C")]);

  // Evaluate acceptance for both runs
  const seqVerdicts = requirements.map((req) => {
    const gateId = asGateId(req.requirementId.replace("R-", ""));
    const gate = seqRes.results.get(gateId)!;
    return acceptanceEngine.evaluateRequirement(
      req,
      [gate],
      Array.from(seqRes.evidences.values()),
      { runId: seqRunId, cycleId: seqCycleId }
    );
  });
  const seqDecision = acceptanceEngine.decideCycle(seqVerdicts, "VERIFY", 0, 2);

  const parVerdicts = requirements.map((req) => {
    const gateId = asGateId(req.requirementId.replace("R-", ""));
    const gate = parRes.results.get(gateId)!;
    return acceptanceEngine.evaluateRequirement(
      req,
      [gate],
      Array.from(parRes.evidences.values()),
      { runId: parRunId, cycleId: parCycleId }
    );
  });
  const parDecision = acceptanceEngine.decideCycle(parVerdicts, "VERIFY", 0, 2);

  // Normalize and compare requirement verdicts
  const normalizeVerdicts = (verdicts: readonly RequirementVerdict[]) =>
    verdicts.map((v) => ({
      requirementId: v.requirementId,
      status: v.status,
      rationale: v.rationale,
    }));
  assert.deepEqual(normalizeVerdicts(seqVerdicts), normalizeVerdicts(parVerdicts));

  // Normalize and compare evidence mappings
  const normalizeEvidences = (evMap: ReadonlyMap<string, QualityEvidence>) =>
    Array.from(evMap.entries()).map(([k, v]) => ({
      gateId: k,
      stdoutSha256: v.stdoutSha256,
      exitCode: v.exitCode,
      termination: v.termination,
    }));
  assert.deepEqual(normalizeEvidences(seqRes.evidences), normalizeEvidences(parRes.evidences));

  // Compare final cycle decision
  assert.deepEqual(seqDecision, parDecision);

  // Compare normalized bundle & markdown reports
  const seqBundle: EvidenceBundle = {
    schemaVersion: 1,
    runId: seqRunId,
    cycleId: seqCycleId,
    phase: "VERIFY",
    configHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    requirementsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    generatedAt: "2026-08-20T10:00:00.000Z",
    gates: Array.from(seqRes.results.values()),
    evidence: Array.from(seqRes.evidences.values()),
    verdicts: seqVerdicts,
    repairHistory: [],
    decision: seqDecision,
    routeIntent: {
      kind: "advance",
      from: "VERIFY",
      to: "ACCEPT",
      causedByEventId: asEventId("ev-1"),
    },
  };

  const parBundle: EvidenceBundle = {
    schemaVersion: 1,
    runId: parRunId,
    cycleId: parCycleId,
    phase: "VERIFY",
    configHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    requirementsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    generatedAt: "2026-08-20T10:00:00.000Z",
    gates: Array.from(parRes.results.values()),
    evidence: Array.from(parRes.evidences.values()),
    verdicts: parVerdicts,
    repairHistory: [],
    decision: parDecision,
    routeIntent: {
      kind: "advance",
      from: "VERIFY",
      to: "ACCEPT",
      causedByEventId: asEventId("ev-2"),
    },
  };

  const seqMd = store.exportSummaryMarkdown(seqBundle);
  const parMd = store.exportSummaryMarkdown(parBundle);

  // Strip dynamic cycle/run IDs and evidence UUIDs, then assert identical structure and semantics
  const stripDynamic = (md: string) =>
    md
      .replace(/cycle-[12]/g, "cycle-X")
      .replace(/run-equiv-[12]/g, "run-X")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "EVID-UUID");
  assert.equal(stripDynamic(seqMd), stripDynamic(parMd));
});

test("runner_rejection_normalizes_to_non_pass", async () => {
  // Verifies runner Promise rejection is normalized without unhandled rejection and active gates settle
  let unhandledRejections = 0;
  const unhandledHandler = () => {
    unhandledRejections++;
  };
  process.on("unhandledRejection", unhandledHandler);

  try {
    const runner: ProcessRunner = {
      run: async (options: { command: string; args: readonly string[]; cwd: string }) => {
        const gateId = options.args[1] ?? options.command;
        if (gateId === "throwing-gate") {
          return Promise.reject(new Error("Process spawn crashed with EACCES"));
        }
        await new Promise((r) => setTimeout(r, 20));
        return {
          stdout: "OK",
          stderr: "",
          durationMs: 20,
          termination: "exited" as const,
          exitCode: 0,
          signal: null,
        };
      },
    };

    const gateRunner = new GateRunner();
    const scheduler = new GateScheduler({ maxParallelGates: 3 });

    const gates = [
      makeGate("throwing-gate"),
      makeGate("independent-success"),
    ];

    const res = await scheduler.schedule(gates, {
      runId: asRunId("run-rejection-1"),
      cycleId: asQualityCycleId("cycle-1"),
      projectRoot: ".",
      runner,
      gateRunner,
    });

    assert.equal(res.results.get(asGateId("throwing-gate"))?.status, "inconclusive");
    assert.equal(res.results.get(asGateId("throwing-gate"))?.failureSignature, "runner_exception");
    assert.match(res.results.get(asGateId("throwing-gate"))?.reason ?? "", /Process spawn crashed with EACCES/);
    assert.equal(res.results.get(asGateId("independent-success"))?.status, "passed");
    assert.equal(unhandledRejections, 0, "Zero unhandled rejections must occur");
  } finally {
    process.removeListener("unhandledRejection", unhandledHandler);
  }
});

test("callback_persistence_error_fails_closed_after_settling", async () => {
  // Verifies that when onGateCompleted throws, queued gates never start, active gates still settle, and scheduler throws QualityError
  let independentGateFinished = false;
  const executedGates: string[] = [];

  const runner: ProcessRunner = {
    run: async (options: { command: string; args: readonly string[]; cwd: string }) => {
      const gateId = options.args[1] ?? options.command;
      executedGates.push(gateId);
      if (gateId === "failing-callback-gate") {
        return {
          stdout: "OK",
          stderr: "",
          durationMs: 10,
          termination: "exited" as const,
          exitCode: 0,
          signal: null,
        };
      }
      if (gateId === "slow-independent-gate") {
        await new Promise((r) => setTimeout(r, 30));
        independentGateFinished = true;
        return {
          stdout: "INDEPENDENT OK",
          stderr: "",
          durationMs: 30,
          termination: "exited" as const,
          exitCode: 0,
          signal: null,
        };
      }
      // Queued gate
      return {
        stdout: "QUEUED OK",
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 2 });

  const gates = [
    makeGate("failing-callback-gate"),
    makeGate("slow-independent-gate"),
    makeGate("queued-remaining-gate"),
  ];

  await assert.rejects(
    () =>
      scheduler.schedule(gates, {
        runId: asRunId("run-cb-err"),
        cycleId: asQualityCycleId("cycle-1"),
        projectRoot: ".",
        runner,
        gateRunner,
        onGateCompleted: async (result) => {
          if (result.gateId === "failing-callback-gate") {
            throw new Error("Disk full: failed to persist durable gate event");
          }
        },
      }),
    (err: unknown) =>
      err instanceof QualityError &&
      err.code === "GATE_EVIDENCE_INVALID" &&
      err.message.includes("Disk full")
  );

  assert.equal(independentGateFinished, true, "Independent active gate must settle before scheduler rejects");
  assert.equal(
    executedGates.includes("queued-remaining-gate"),
    false,
    "Queued gate must NEVER execute after onGateCompleted persistence error"
  );
});

test("callback_started_persistence_error_prevents_runner_execution", async () => {
  // Verifies that when onGateStarted throws, that gate's process runner is NEVER called (0 executions),
  // queued gates never start, and other active gates settle cleanly
  let activeSlowFinished = false;
  const executedGates: string[] = [];

  const runner: ProcessRunner = {
    run: async (options: { command: string; args: readonly string[]; cwd: string }) => {
      const gateId = options.args[1] ?? options.command;
      executedGates.push(gateId);
      if (gateId === "active-slow-gate") {
        await new Promise((r) => setTimeout(r, 30));
        activeSlowFinished = true;
      }
      return {
        stdout: `OUTPUT for ${gateId}`,
        stderr: "",
        durationMs: 10,
        termination: "exited" as const,
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 2 });

  const gates = [
    makeGate("failing-started-gate"),
    makeGate("active-slow-gate"),
    makeGate("queued-gate-after-start-fail"),
  ];

  await assert.rejects(
    () =>
      scheduler.schedule(gates, {
        runId: asRunId("run-start-err"),
        cycleId: asQualityCycleId("cycle-1"),
        projectRoot: ".",
        runner,
        gateRunner,
        onGateStarted: async (gate) => {
          if (gate.id === "failing-started-gate") {
            throw new Error("Disk full: failed to record durable gate started event");
          }
        },
      }),
    (err: unknown) =>
      err instanceof QualityError &&
      err.code === "GATE_EVIDENCE_INVALID" &&
      err.message.includes("Disk full")
  );

  assert.equal(
    executedGates.includes("failing-started-gate"),
    false,
    "Process runner must NEVER execute for gate whose onGateStarted failed (side-effect prevented)"
  );
  assert.equal(
    executedGates.includes("queued-gate-after-start-fail"),
    false,
    "Queued gate must NEVER execute after onGateStarted persistence error"
  );
  assert.equal(activeSlowFinished, true, "Already active gate must finish settling cleanly");
});

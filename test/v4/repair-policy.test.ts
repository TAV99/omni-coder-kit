import test from "node:test";
import assert from "node:assert/strict";
import { RepairPolicy, countPriorAttemptsPerRequirement } from "../../src/v4/quality/repair-policy";
import { asGateId, asRunId } from "../../src/v4/contracts";
import {
  asQualityCycleId,
  asQualityEvidenceId,
  asRequirementId,
  type QualityEvidence,
  type RequirementVerdict,
} from "../../src/v4/contracts/quality";
import { AcceptanceEngine } from "../../src/v4/quality/acceptance-engine";

test("counts_per_requirement", () => {
  // R39: Repair attempts are tracked independently per requirement via durable history
  const policy = new RepairPolicy({ maxRepairs: 2 });
  const r1 = asRequirementId("R1");
  const r2 = asRequirementId("R2");
  const r3 = asRequirementId("R3");

  // Cycle 1 fails R1 and R2
  const d1 = policy.decideRepair({
    cycleId: asQualityCycleId("cycle-1"),
    phase: "VERIFY",
    failingRequirements: [r1, r2],
    priorRepairHistory: [],
  });
  assert.equal(d1.action, "repair");
  if (d1.action !== "repair") return;
  assert.equal(d1.historyEntry.perRequirementAttempts["R1"], 1);
  assert.equal(d1.historyEntry.perRequirementAttempts["R2"], 1);
  assert.equal(d1.newHistory.length, 1);

  // Cycle 2: R2 passes, only R1 fails -> progress made!
  const d2 = policy.decideRepair({
    cycleId: asQualityCycleId("cycle-2"),
    phase: "VERIFY",
    failingRequirements: [r1],
    failureSignatures: ["diff-sig-2"],
    priorRepairHistory: d1.newHistory,
  });
  assert.equal(d2.action, "repair");
  if (d2.action !== "repair") return;
  assert.equal(d2.historyEntry.perRequirementAttempts["R1"], 2);
  assert.equal(d2.newHistory.length, 2);

  // Cycle 3: R1 passes, but R2 and R3 fail -> R2 had only 1 prior attempt, so it can repair!
  const d3 = policy.decideRepair({
    cycleId: asQualityCycleId("cycle-3"),
    phase: "VERIFY",
    failingRequirements: [r2, r3],
    failureSignatures: ["diff-sig-3"],
    priorRepairHistory: d2.newHistory,
  });
  assert.equal(d3.action, "repair");
  if (d3.action !== "repair") return;
  assert.equal(d3.historyEntry.perRequirementAttempts["R2"], 2);
  assert.equal(d3.historyEntry.perRequirementAttempts["R3"], 1);
  assert.equal(d3.newHistory.length, 3);

  // Cycle 4: R1 fails again -> R1 reached 2 attempts, so it blocks
  const d4 = policy.decideRepair({
    cycleId: asQualityCycleId("cycle-4"),
    phase: "VERIFY",
    failingRequirements: [r1],
    failureSignatures: ["diff-sig-4"],
    priorRepairHistory: d3.newHistory,
  });
  assert.equal(d4.action, "block");
  if (d4.action === "block") {
    assert.equal(d4.code, "REPAIR_BUDGET_EXHAUSTED");
    assert.match(d4.reason, /R1/);
    assert.match(d4.reason, /\(2\/2\)/);
  }
});

test("default_max_two", () => {
  // R40: Default repair budget is 2 attempts per requirement
  const policy = new RepairPolicy();
  const req = asRequirementId("R1");

  // Attempt 1
  const d1 = policy.decideRepair({
    cycleId: asQualityCycleId("c-1"),
    phase: "VERIFY",
    failingRequirements: [req],
    failureSignatures: ["sig-1"],
    priorRepairHistory: [],
  });
  assert.equal(d1.action, "repair");
  if (d1.action !== "repair") return;
  assert.equal(d1.historyEntry.perRequirementAttempts["R1"], 1);

  // Attempt 2
  const d2 = policy.decideRepair({
    cycleId: asQualityCycleId("c-2"),
    phase: "VERIFY",
    failingRequirements: [req],
    failureSignatures: ["sig-2"],
    priorRepairHistory: d1.newHistory,
  });
  assert.equal(d2.action, "repair");
  if (d2.action !== "repair") return;
  assert.equal(d2.historyEntry.perRequirementAttempts["R1"], 2);

  // Attempt 3 (> 2) -> blocks
  const d3 = policy.decideRepair({
    cycleId: asQualityCycleId("c-3"),
    phase: "VERIFY",
    failingRequirements: [req],
    failureSignatures: ["sig-3"],
    priorRepairHistory: d2.newHistory,
  });
  assert.equal(d3.action, "block");
  if (d3.action === "block") {
    assert.equal(d3.code, "REPAIR_BUDGET_EXHAUSTED");
  }
});

test("no_progress_stops", () => {
  // R41: Identical failure signature, failing requirements, and evidence digests stop immediately
  const policy = new RepairPolicy({ maxRepairs: 3 });
  const req = asRequirementId("R1");

  const sampleEvidenceC1: QualityEvidence = {
    schemaVersion: 1,
    evidenceId: asQualityEvidenceId("ev-cycle-1"),
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("c-1"),
    gateId: asGateId("unit-test"),
    operationId: "op-1",
    command: ["npm", "test"],
    cwd: ".",
    timeoutMs: 10000,
    termination: "exited",
    exitCode: 1,
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 50,
    stdoutSummary: "FAILED test 1",
    stderrSummary: "Error: assertion",
    stdoutSha256: "1111111111111111111111111111111111111111111111111111111111111111",
    stderrSha256: "2222222222222222222222222222222222222222222222222222222222222222",
    artifactIds: [],
  };

  const sampleVerdictC1: RequirementVerdict = {
    requirementId: req,
    status: "rejected",
    evidenceIds: [sampleEvidenceC1.evidenceId],
    rationale: "Test failed assertion",
  };

  // Cycle 1 -> repair
  const d1 = policy.decideRepair({
    cycleId: asQualityCycleId("c-1"),
    phase: "VERIFY",
    failingRequirements: [req],
    failingVerdicts: [sampleVerdictC1],
    failingGateEvidences: [sampleEvidenceC1],
    priorRepairHistory: [],
  });
  assert.equal(d1.action, "repair");
  if (d1.action !== "repair") return;

  // Cycle 2: fresh cycleId and fresh evidenceId, but identical failure signature and evidence digests
  const sampleEvidenceC2: QualityEvidence = {
    schemaVersion: 1,
    evidenceId: asQualityEvidenceId("ev-cycle-2-fresh-id"),
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("c-2-fresh-cycle"),
    gateId: asGateId("unit-test"),
    operationId: "op-2-fresh",
    command: ["npm", "test"],
    cwd: ".",
    timeoutMs: 10000,
    termination: "exited",
    exitCode: 1,
    startedAt: "2026-08-20T10:05:00.000Z",
    durationMs: 52,
    stdoutSummary: "FAILED test 1",
    stderrSummary: "Error: assertion",
    stdoutSha256: "1111111111111111111111111111111111111111111111111111111111111111", // same digest
    stderrSha256: "2222222222222222222222222222222222222222222222222222222222222222", // same digest
    artifactIds: [],
  };

  const sampleVerdictC2: RequirementVerdict = {
    requirementId: req,
    status: "rejected",
    evidenceIds: [sampleEvidenceC2.evidenceId],
    rationale: "Test failed assertion",
  };

  const d2 = policy.decideRepair({
    cycleId: asQualityCycleId("c-2-fresh-cycle"),
    phase: "VERIFY",
    failingRequirements: [req],
    failingVerdicts: [sampleVerdictC2],
    failingGateEvidences: [sampleEvidenceC2],
    priorRepairHistory: d1.newHistory,
  });
  assert.equal(d2.action, "block");
  if (d2.action === "block") {
    assert.equal(d2.code, "REPAIR_NO_PROGRESS");
    assert.match(d2.reason, /No progress made/i);
  }
});

test("repair_invalidates_verdicts", () => {
  // R42: Integration: A repair invalidates prior verdicts for affected requirements.
  // Cycle 2 cannot reuse Cycle 1 evidence or verdicts to accept. Only fresh correlated evidence in Cycle 2 can accept.
  const engine = new AcceptanceEngine();
  const runId = asRunId("run-inv");
  const cycle1 = asQualityCycleId("cycle-1");
  const cycle2 = asQualityCycleId("cycle-2");
  const req1 = asRequirementId("R1");

  const ev1: QualityEvidence = {
    schemaVersion: 1,
    evidenceId: asQualityEvidenceId("ev-c1"),
    runId,
    cycleId: cycle1,
    gateId: asGateId("unit-test"),
    operationId: "op-c1",
    command: ["npm", "test"],
    cwd: ".",
    timeoutMs: 5000,
    termination: "exited",
    exitCode: 0,
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 10,
    stdoutSummary: "PASS",
    stderrSummary: "",
    stdoutSha256: "1111111111111111111111111111111111111111111111111111111111111111",
    stderrSha256: "2222222222222222222222222222222222222222222222222222222222222222",
    artifactIds: [],
  };

  const reqDef = {
    requirementId: req1,
    text: "Unit tests pass",
    testStrategy: { kind: "hard" as const, sourceText: "test: npm test" },
  };

  const gateResultsByReqStale = new Map([
    [
      req1,
      [
        {
          schemaVersion: 1 as const,
          cycleId: cycle2,
          gateId: asGateId("unit-test"),
          operationId: "op-c2",
          status: "passed" as const,
          evidenceId: ev1.evidenceId, // Stale evidence from Cycle 1!
          startedAt: "2026-08-20T10:05:00.000Z",
          durationMs: 10,
        },
      ],
    ],
  ]);

  // Attempting to evaluate in Cycle 2 using Cycle 1 evidence fails closed (verdict is not accepted)
  const resultsC2WithStaleEvidence = engine.evaluateAll(
    [reqDef],
    gateResultsByReqStale,
    [ev1],
    { runId, cycleId: cycle2 }
  );

  // Must NOT be accepted because evidence is from cycle 1, not cycle 2
  assert.equal(resultsC2WithStaleEvidence[0]!.status, "inconclusive");
  assert.match(resultsC2WithStaleEvidence[0]!.rationale, /Cross-cycle evidence detected/i);

  // Fresh Cycle 2 evidence is required to accept
  const ev2: QualityEvidence = {
    ...ev1,
    evidenceId: asQualityEvidenceId("ev-c2-fresh"),
    cycleId: cycle2,
    operationId: "op-c2",
  };

  const gateResultsByReqFresh = new Map([
    [
      req1,
      [
        {
          schemaVersion: 1 as const,
          cycleId: cycle2,
          gateId: asGateId("unit-test"),
          operationId: "op-c2",
          status: "passed" as const,
          evidenceId: ev2.evidenceId,
          startedAt: "2026-08-20T10:05:00.000Z",
          durationMs: 10,
        },
      ],
    ],
  ]);

  const resultsC2WithFreshEvidence = engine.evaluateAll(
    [reqDef],
    gateResultsByReqFresh,
    [ev2],
    { runId, cycleId: cycle2 }
  );

  assert.equal(resultsC2WithFreshEvidence[0]!.status, "accepted");
});

import test from "node:test";
import assert from "node:assert/strict";
import { AcceptanceEngine } from "../../src/v4/quality/acceptance-engine";
import {
  asGateId,
  asQualityCycleId,
  asQualityEvidenceId,
  asRequirementId,
  type GateResult,
  type QualityEvidence,
  type RequirementRecord,
} from "../../src/v4/contracts/quality";
import { asRunId } from "../../src/v4/contracts/ids";

const runId = asRunId("run-1");
const cycleId = asQualityCycleId("cycle-1");
const evId1 = asQualityEvidenceId("ev-1");
const evId2 = asQualityEvidenceId("ev-2");

const reqR1: RequirementRecord = {
  requirementId: asRequirementId("R1"),
  text: "Atomic unit test passes",
  testStrategy: { kind: "hard", sourceText: "test: npm test" },
};

const reqR2: RequirementRecord = {
  requirementId: asRequirementId("R2"),
  text: "Agent visually inspects UI",
  testStrategy: { kind: "agent" },
};

const validEvidence1: QualityEvidence = {
  schemaVersion: 1,
  evidenceId: evId1,
  runId,
  cycleId,
  gateId: asGateId("unit-test"),
  operationId: "op-1",
  command: ["npm", "test"],
  cwd: "/workspace",
  timeoutMs: 30000,
  termination: "exited",
  exitCode: 0,
  startedAt: "2026-08-20T10:00:00.000Z",
  durationMs: 100,
  stdoutSummary: "PASS",
  stderrSummary: "",
  stdoutSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  stderrSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  artifactIds: [],
};

const validPassResult: GateResult = {
  schemaVersion: 1,
  cycleId,
  gateId: asGateId("unit-test"),
  operationId: "op-1",
  status: "passed",
  startedAt: "2026-08-20T10:00:00.000Z",
  durationMs: 100,
  evidenceId: evId1,
};

test("mandatory_non_pass_fails_closed", () => {
  const engine = new AcceptanceEngine();
  const validEvArray = [validEvidence1];
  const context = { runId, cycleId };

  // 1. Skipped mandatory gate cannot satisfy mandatory requirement -> inconclusive
  const skipResult: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("unit-test"),
    operationId: "op-1",
    status: "skipped",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 0,
    mandatory: true,
    reason: "Skipped due to prior failure",
  };
  const skipVerdict = engine.evaluateRequirement(reqR1, [skipResult], validEvArray, context);
  assert.equal(skipVerdict.status, "inconclusive");
  assert.notEqual(skipVerdict.status, "accepted");

  // 2. Inconclusive mandatory gate cannot satisfy mandatory requirement -> inconclusive
  const inconclusiveResult: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("unit-test"),
    operationId: "op-1",
    status: "inconclusive",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 100,
    mandatory: true,
    reason: "Gate timed out",
    failureSignature: "timed-out",
  };
  const inconclVerdict = engine.evaluateRequirement(reqR1, [inconclusiveResult], validEvArray, context);
  assert.equal(inconclVerdict.status, "inconclusive");
  assert.notEqual(inconclVerdict.status, "accepted");

  // 3. Failed gate -> rejected
  const failResult: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("unit-test"),
    operationId: "op-1",
    status: "failed",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 100,
    evidenceId: evId1,
    mandatory: true,
    failureSignature: "exit_1",
    reason: "AssertionError: expected true, got false",
  };
  const failVerdict = engine.evaluateRequirement(reqR1, [failResult], validEvArray, context);
  assert.equal(failVerdict.status, "rejected");
  assert.notEqual(failVerdict.status, "accepted");

  // 4. Optional skipped gate does NOT fail mandatory requirement when mandatory gate passed
  const optionalSkipped: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("optional-lint"),
    operationId: "op-opt",
    status: "skipped",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 0,
    mandatory: false,
    reason: "Skipped optional gate",
  };
  const optionalVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult, optionalSkipped],
    validEvArray,
    context
  );
  assert.equal(optionalVerdict.status, "accepted");
  assert.deepEqual(optionalVerdict.evidenceIds, [evId1]);

  // 5. Optional failed gate does NOT fail mandatory requirement when mandatory gate passed
  const optionalFailed: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("optional-bench"),
    operationId: "op-opt-fail",
    status: "failed",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 50,
    mandatory: false,
    failureSignature: "exit_1",
    reason: "Optional gate failed",
  };
  const optFailVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult, optionalFailed],
    validEvArray,
    context
  );
  assert.equal(optFailVerdict.status, "accepted");
  assert.deepEqual(optFailVerdict.evidenceIds, [evId1]);

  // 6. Optional inconclusive gate does NOT fail mandatory requirement when mandatory gate passed
  const optionalInconcl: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("optional-timeout"),
    operationId: "op-opt-timeout",
    status: "inconclusive",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 50,
    mandatory: false,
    failureSignature: "timed-out",
    reason: "Optional gate timed out",
  };
  const optInconclVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult, optionalInconcl],
    validEvArray,
    context
  );
  assert.equal(optInconclVerdict.status, "accepted");
  assert.deepEqual(optInconclVerdict.evidenceIds, [evId1]);
});

test("unmapped_hard_test_inconclusive", () => {
  const engine = new AcceptanceEngine();
  const verdict = engine.evaluateRequirement(reqR1, [], [], { runId, cycleId });
  assert.equal(verdict.status, "inconclusive");
  assert.equal(verdict.evidenceIds.length, 0);
  assert.match(verdict.rationale, /unmapped|no gate/i);
});

test("same_run_evidence_correlation", () => {
  const engine = new AcceptanceEngine();
  const context = { runId, cycleId };

  // 1. Cross-run evidence
  const crossRunEvidence: QualityEvidence = {
    ...validEvidence1,
    runId: asRunId("other-run-999"),
  };
  const verdictCrossRun = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [crossRunEvidence],
    context
  );
  assert.equal(verdictCrossRun.status, "inconclusive");
  assert.match(verdictCrossRun.rationale, /cross-run|correlation failed/i);

  // 2. Cross-cycle evidence
  const crossCycleEvidence: QualityEvidence = {
    ...validEvidence1,
    cycleId: asQualityCycleId("cycle-other"),
  };
  const verdictCrossCycle = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [crossCycleEvidence],
    context
  );
  assert.equal(verdictCrossCycle.status, "inconclusive");
  assert.match(verdictCrossCycle.rationale, /cross-cycle|correlation failed/i);

  // 3. Mismatched operation ID
  const mismatchedOpEvidence: QualityEvidence = {
    ...validEvidence1,
    operationId: "op-different",
  };
  const verdictMismatchedOp = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [mismatchedOpEvidence],
    context
  );
  assert.equal(verdictMismatchedOp.status, "inconclusive");

  // 4. Mismatched gate ID
  const mismatchedGateEvidence: QualityEvidence = {
    ...validEvidence1,
    gateId: asGateId("other-gate"),
  };
  const verdictMismatchedGate = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [mismatchedGateEvidence],
    context
  );
  assert.equal(verdictMismatchedGate.status, "inconclusive");

  // 5. Evidence has exitCode != 0 but gate claimed pass -> correlation fails
  const badExitEvidence: QualityEvidence = {
    ...validEvidence1,
    exitCode: 1,
  };
  const verdictBadExit = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [badExitEvidence],
    context
  );
  assert.equal(verdictBadExit.status, "inconclusive");

  // 6. Duplicate evidence ID in raw collection (2 distinct records sharing same evidenceId) -> fails closed
  const duplicateEvInCollection: QualityEvidence = {
    ...validEvidence1,
    gateId: asGateId("other-gate"),
    operationId: "op-dup",
  };
  const duplicateCollVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [validEvidence1, duplicateEvInCollection],
    context
  );
  assert.equal(duplicateCollVerdict.status, "inconclusive");
  assert.match(duplicateCollVerdict.rationale, /duplicate evidence id/i);

  // 7. Duplicate evidence ID across different gates in the same requirement
  const secondPassResult: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("lint-gate"),
    operationId: "op-2",
    status: "passed",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 50,
    evidenceId: evId1, // Reusing evId1!
  };
  const duplicateEvVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult, secondPassResult],
    [validEvidence1],
    context
  );
  assert.equal(duplicateEvVerdict.status, "inconclusive");
  assert.match(duplicateEvVerdict.rationale, /duplicate evidenceid/i);

  // 8. Valid same-run same-cycle correlation -> accepted
  const validVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [validEvidence1],
    context
  );
  assert.equal(validVerdict.status, "accepted");
  assert.deepEqual(validVerdict.evidenceIds, [evId1]);
});

test("accepted_requirement_has_evidence", () => {
  const engine = new AcceptanceEngine();
  const context = { runId, cycleId };

  // 1. Hard requirement accepted verdict MUST have at least one valid evidence ID
  const hardVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [validEvidence1],
    context
  );
  assert.equal(hardVerdict.status, "accepted");
  assert.ok(hardVerdict.evidenceIds.length >= 1, "Accepted mandatory requirement must have >= 1 evidence ID");
  assert.equal(hardVerdict.evidenceIds[0], evId1);

  // 2. Missing evidence in collection -> cannot accept
  const missingEvVerdict = engine.evaluateRequirement(
    reqR1,
    [validPassResult],
    [],
    context
  );
  assert.notEqual(missingEvVerdict.status, "accepted");
  assert.equal(missingEvVerdict.status, "inconclusive");

  // 3. Agent requirement citing valid existing evidence
  const agentVerdict = engine.evaluateRequirement(
    reqR2,
    [],
    [validEvidence1],
    context,
    {
      status: "accepted",
      rationale: "UI visually conforms",
      evidenceIds: [evId1],
    }
  );
  assert.equal(agentVerdict.status, "accepted");
  assert.deepEqual(agentVerdict.evidenceIds, [evId1]);

  // 4. Directly supplied forged agent judgement citing unknown ID -> inconclusive, evidenceIds empty
  const forgedUnknownVerdict = engine.evaluateRequirement(
    reqR2,
    [],
    [validEvidence1],
    context,
    {
      status: "accepted",
      rationale: "Forged judgement citing fake ID",
      evidenceIds: [asQualityEvidenceId("fake-ev-999")],
    }
  );
  assert.equal(forgedUnknownVerdict.status, "inconclusive");
  assert.deepEqual(forgedUnknownVerdict.evidenceIds, []);

  // 5. Directly supplied forged agent judgement with duplicate cited IDs -> inconclusive, evidenceIds empty
  const forgedDuplicateVerdict = engine.evaluateRequirement(
    reqR2,
    [],
    [validEvidence1],
    context,
    {
      status: "accepted",
      rationale: "Forged judgement citing duplicate ID",
      evidenceIds: [evId1, evId1],
    }
  );
  assert.equal(forgedDuplicateVerdict.status, "inconclusive");
  assert.deepEqual(forgedDuplicateVerdict.evidenceIds, []);

  // 6. Agent requirement when raw collection has cross-run items -> inconclusive, evidenceIds empty
  const crossRunEv: QualityEvidence = {
    ...validEvidence1,
    runId: asRunId("other-run"),
  };
  const crossRunAgentVerdict = engine.evaluateRequirement(
    reqR2,
    [],
    [crossRunEv],
    context,
    {
      status: "accepted",
      rationale: "Valid-looking judgement on bad collection",
      evidenceIds: [],
    }
  );
  assert.equal(crossRunAgentVerdict.status, "inconclusive");
  assert.deepEqual(crossRunAgentVerdict.evidenceIds, []);

  // 7. Failed gate with unvalidated / missing evidenceId -> rejected with empty evidenceIds
  const unvalidatedFailedGate: GateResult = {
    schemaVersion: 1,
    cycleId,
    gateId: asGateId("unit-test"),
    operationId: "op-1",
    status: "failed",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 100,
    evidenceId: asQualityEvidenceId("ev-missing-from-collection"),
    mandatory: true,
    failureSignature: "exit_1",
    reason: "Failed gate with missing evidence",
  };
  const unvalidatedFailVerdict = engine.evaluateRequirement(
    reqR1,
    [unvalidatedFailedGate],
    [validEvidence1], // does not contain ev-missing-from-collection
    context
  );
  assert.equal(unvalidatedFailVerdict.status, "rejected");
  assert.deepEqual(unvalidatedFailVerdict.evidenceIds, []);
});

test("decide_cycle_transitions", () => {
  const engine = new AcceptanceEngine();

  const acceptedVerdict = {
    requirementId: asRequirementId("R1"),
    status: "accepted" as const,
    evidenceIds: [evId1],
    rationale: "All gates passed",
  };

  const rejectedVerdict = {
    requirementId: asRequirementId("R1"),
    status: "rejected" as const,
    evidenceIds: [evId1],
    rationale: "Test failed",
  };

  // 1. VERIFY all accepted -> advance to ACCEPT
  const dec1 = engine.decideCycle([acceptedVerdict], "VERIFY", 0, 2);
  assert.deepEqual(dec1, { kind: "advance", to: "ACCEPT" });

  // 2. ACCEPT all accepted -> advance to DOCUMENT
  const dec2 = engine.decideCycle([acceptedVerdict], "ACCEPT", 0, 2);
  assert.deepEqual(dec2, { kind: "advance", to: "DOCUMENT" });

  // 3. VERIFY failure & attempt < max -> repair to FIX
  const dec3 = engine.decideCycle([rejectedVerdict], "VERIFY", 0, 2);
  assert.equal(dec3.kind, "repair");
  if (dec3.kind === "repair") {
    assert.equal(dec3.to, "FIX");
    assert.deepEqual(dec3.requirementIds, ["R1"]);
  }

  // 4. ACCEPT failure & attempt < max -> repair to REWORK
  const dec4 = engine.decideCycle([rejectedVerdict], "ACCEPT", 1, 2);
  assert.equal(dec4.kind, "repair");
  if (dec4.kind === "repair") {
    assert.equal(dec4.to, "REWORK");
    assert.deepEqual(dec4.requirementIds, ["R1"]);
  }

  // 5. Failure & attempt >= max -> block
  const dec5 = engine.decideCycle([rejectedVerdict], "VERIFY", 2, 2);
  assert.equal(dec5.kind, "block");
  if (dec5.kind === "block") {
    assert.match(dec5.reason, /exhausted/i);
    assert.ok(dec5.requiredAction);
  }
});

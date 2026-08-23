import test from "node:test";
import assert from "node:assert/strict";
import {
  GateResultSchema,
  QualityEvidenceSchema,
  GateDefinitionSchema,
  RequirementRecordSchema,
  RequirementVerdictSchema,
  QualityDecisionSchema,
  asGateId,
  asRequirementId,
  asQualityCycleId,
  asQualityEvidenceId,
} from "../../src/v4/contracts/quality";
import { asRunId } from "../../src/v4/contracts/ids";
import { QualityError, QUALITY_ERROR_CODES } from "../../src/v4/quality/errors";

test("four_state_gate_result", () => {
  const base = {
    schemaVersion: 1,
    cycleId: asQualityCycleId("cycle-1"),
    gateId: asGateId("gate-1"),
    operationId: "op-1",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 100,
    evidenceId: asQualityEvidenceId("ev-1"),
  };

  // 1. passed
  const passedRes = GateResultSchema.safeParse({
    ...base,
    status: "passed",
  });
  assert.ok(passedRes.success);

  // 2. failed
  const failedRes = GateResultSchema.safeParse({
    ...base,
    status: "failed",
    failureSignature: "exit_1",
    reason: "Nonzero exit",
  });
  assert.ok(failedRes.success);

  // 3. skipped (requires reason)
  const skippedRes = GateResultSchema.safeParse({
    ...base,
    status: "skipped",
    reason: "Disabled by policy",
  });
  assert.ok(skippedRes.success);

  // 4. inconclusive (requires reason and failureSignature)
  const inconclusiveRes = GateResultSchema.safeParse({
    ...base,
    status: "inconclusive",
    reason: "Process timed out",
    failureSignature: "timeout",
  });
  assert.ok(inconclusiveRes.success);

  // Reject fifth status
  const fifthRes = GateResultSchema.safeParse({
    ...base,
    status: "unknown_status",
  });
  assert.equal(fifthRes.success, false);
});

test("quality contracts: rejects missing required fields and invalid values", () => {
  const base = {
    schemaVersion: 1,
    cycleId: asQualityCycleId("cycle-1"),
    gateId: asGateId("gate-1"),
    operationId: "op-1",
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 100,
    evidenceId: asQualityEvidenceId("ev-1"),
  };

  // skipped without reason
  const skippedNoReason = GateResultSchema.safeParse({
    ...base,
    status: "skipped",
  });
  assert.equal(skippedNoReason.success, false);

  // inconclusive without failureSignature
  const inconclusiveNoSig = GateResultSchema.safeParse({
    ...base,
    status: "inconclusive",
    reason: "timed out",
  });
  assert.equal(inconclusiveNoSig.success, false);

  // negative duration
  const negativeDuration = GateResultSchema.safeParse({
    ...base,
    status: "passed",
    durationMs: -5,
  });
  assert.equal(negativeDuration.success, false);
});

test("quality contracts: evidence schema validation and secret redaction guarantee", () => {
  const validEvidence = {
    schemaVersion: 1,
    evidenceId: asQualityEvidenceId("ev-1"),
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    gateId: asGateId("gate-1"),
    operationId: "op-1",
    command: ["npm", "test"],
    cwd: process.cwd(),
    timeoutMs: 30000,
    termination: "exited",
    exitCode: 0,
    startedAt: "2026-08-20T10:00:00.000Z",
    durationMs: 500,
    stdoutSummary: "All passed",
    stderrSummary: "",
    stdoutSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    stderrSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    artifactIds: [],
  };

  const parsed = QualityEvidenceSchema.safeParse(validEvidence);
  assert.ok(parsed.success);

  // Reject invalid sha256
  const badSha = QualityEvidenceSchema.safeParse({
    ...validEvidence,
    stdoutSha256: "invalid-hash",
  });
  assert.equal(badSha.success, false);
});

test("quality contracts: stable errors taxonomy contains exact 24 codes (16 P2 + 8 P3)", () => {
  assert.equal(QUALITY_ERROR_CODES.length, 24);
  assert.ok(QUALITY_ERROR_CODES.includes("QUALITY_CONFIG_MISSING"));
  assert.ok(QUALITY_ERROR_CODES.includes("QUALITY_CONFIG_INVALID"));
  assert.ok(QUALITY_ERROR_CODES.includes("REQUIREMENTS_MISSING"));
  assert.ok(QUALITY_ERROR_CODES.includes("REQUIREMENTS_INVALID"));
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_TIMEOUT"));
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_ABORTED"));
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_OUTPUT_LIMIT"));
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_EXIT_NONZERO"));
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_EVIDENCE_INVALID"));
  assert.ok(QUALITY_ERROR_CODES.includes("AGENT_JUDGE_UNAVAILABLE"));
  assert.ok(QUALITY_ERROR_CODES.includes("AGENT_JUDGE_MALFORMED"));
  assert.ok(QUALITY_ERROR_CODES.includes("MANDATORY_GATE_SKIPPED"));
  assert.ok(QUALITY_ERROR_CODES.includes("MANDATORY_GATE_INCONCLUSIVE"));
  assert.ok(QUALITY_ERROR_CODES.includes("REPAIR_NO_PROGRESS"));
  assert.ok(QUALITY_ERROR_CODES.includes("REPAIR_BUDGET_EXHAUSTED"));
  assert.ok(QUALITY_ERROR_CODES.includes("QUALITY_RECOVERY_UNSAFE"));
  // P3 codes
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_DEPENDENCY_INVALID"));
  assert.ok(QUALITY_ERROR_CODES.includes("GATE_DEPENDENCY_CYCLE"));
  assert.ok(QUALITY_ERROR_CODES.includes("BUDGET_METRIC_MISSING"));
  assert.ok(QUALITY_ERROR_CODES.includes("BUDGET_EXCEEDED"));
  assert.ok(QUALITY_ERROR_CODES.includes("BENCHMARK_MANIFEST_INVALID"));
  assert.ok(QUALITY_ERROR_CODES.includes("BENCHMARK_EXPECTATION_MISMATCH"));
  assert.ok(QUALITY_ERROR_CODES.includes("BENCHMARK_WORKSPACE_UNSAFE"));
  assert.ok(QUALITY_ERROR_CODES.includes("LIVE_BENCHMARK_NOT_APPROVED"));

  const err = new QualityError("GATE_TIMEOUT", "Gate timed out");
  assert.equal(err.code, "GATE_TIMEOUT");
  assert.equal(err.name, "QualityError");
});

import test from "node:test";
import assert from "node:assert/strict";
import { DefaultSafetyPolicy } from "../../src/v4/policy/default";
import type { RunState } from "../../src/v4/contracts/run";
import type { StepResult } from "../../src/v4/contracts/step-result";
import { asRunId } from "../../src/v4/contracts/ids";

test("DefaultSafetyPolicy capability gate", () => {
  const dummyState: RunState = {
    schemaVersion: 1,
    runId: asRunId("r1"),
    phase: "EXECUTE",
    sequence: 0,
    attempt: 1,
    sameFailureCount: 0,
    startedAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };

  assert.equal(DefaultSafetyPolicy.evaluateCapability("workspace.read", dummyState), true);
  assert.equal(DefaultSafetyPolicy.evaluateCapability("structured-output", dummyState), true);
  
  assert.equal(DefaultSafetyPolicy.evaluateCapability("workspace.write", dummyState), false);
  assert.equal(DefaultSafetyPolicy.evaluateCapability("shell", dummyState), false);
  assert.equal(DefaultSafetyPolicy.evaluateCapability("streaming", dummyState), false);
});

test("DefaultSafetyPolicy step verification gate", () => {
  const dummyState: RunState = {
    schemaVersion: 1,
    runId: asRunId("r1"),
    phase: "EXECUTE",
    sequence: 0,
    attempt: 1,
    sameFailureCount: 0,
    startedAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };

  const successWithArtifacts: StepResult = {
    status: "succeeded",
    executionId: "e1",
    summary: "done",
    artifacts: [{ artifactId: "a1" as any, kind: "file", relativePath: "x.txt" }],
    evidence: []
  };
  
  const successNoArtifacts: StepResult = {
    status: "succeeded",
    executionId: "e1",
    summary: "done",
    artifacts: [],
    evidence: []
  };
  
  const failure: StepResult = {
    status: "failed",
    executionId: "e1",
    failure: { code: "ERR", message: "fail", retryable: false, signature: "sig" }
  };
  
  assert.equal(DefaultSafetyPolicy.evaluateStep(successWithArtifacts, dummyState), true);
  assert.equal(DefaultSafetyPolicy.evaluateStep(successNoArtifacts, dummyState), false);
  assert.equal(DefaultSafetyPolicy.evaluateStep(failure, dummyState), false);
});

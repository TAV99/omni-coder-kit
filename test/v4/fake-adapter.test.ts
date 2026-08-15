import test from "node:test";
import assert from "node:assert/strict";
import { FakeAdapter } from "../../src/v4/adapters/fake";
import type { StepResult } from "../../src/v4/contracts/step-result";
import type { RunState } from "../../src/v4/contracts/run";
import { asRunId } from "../../src/v4/contracts/ids";

test("FakeAdapter returns queued results and throws when exhausted", async () => {
  const result1: StepResult = {
    status: "succeeded",
    executionId: "exec1",
    summary: "first",
    artifacts: [],
    evidence: []
  };
  
  const result2: StepResult = {
    status: "failed",
    executionId: "exec2",
    failure: { code: "ERR", message: "second", retryable: false, signature: "sig" }
  };

  const adapter = new FakeAdapter([result1, result2]);
  
  const state: RunState = {
    schemaVersion: 1,
    runId: asRunId("r1"),
    phase: "EXECUTE",
    sequence: 0,
    attempt: 1,
    sameFailureCount: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const r1 = await adapter.executeStep(state);
  assert.equal(r1.executionId, "exec1");
  
  const r2 = await adapter.executeStep(state);
  assert.equal(r2.executionId, "exec2");
  
  await assert.rejects(adapter.executeStep(state), /FakeAdapter queue is empty/);
});

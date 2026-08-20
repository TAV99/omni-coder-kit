import test from "node:test";
import assert from "node:assert/strict";
import { FakeAdapter } from "../../src/v4/testing/fake-adapter";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";

const dummyReq: StepRequest = {
  runId: asRunId("run-1"),
  stepId: asStepId("step-1"),
  phase: "INTAKE",
  operationId: "op-1",
  workspaceDir: "/w",
  prompt: "test",
  requiredCapabilities: ["workspace.read"],
  sideEffect: "read-only",
  timeoutMs: 5000,
};

test("fake-adapter: probe, queued outcomes, and cancel tracking", async () => {
  const customErr = new Error("simulated failure");
  const adapter = new FakeAdapter({
    id: "test-fake",
    available: true,
    capabilities: ["workspace.read"],
    outcomes: [
      { kind: "return", value: { status: "succeeded", executionId: "op-1" } },
      { kind: "throw", error: customErr },
    ],
  });

  const probe = await adapter.probe();
  assert.equal(probe.adapterId, "test-fake");
  assert.equal(probe.available, true);

  const ctx = {
    signal: new AbortController().signal,
    elevatedPermissions: false,
  };

  const res1 = await adapter.execute(dummyReq, ctx);
  assert.deepEqual(res1, { status: "succeeded", executionId: "op-1" });

  await assert.rejects(adapter.execute(dummyReq, ctx), (err) => err === customErr);

  // Queue exhausted -> error
  await assert.rejects(adapter.execute(dummyReq, ctx), /No queued FakeOutcome remaining/);

  await adapter.cancel("exec-123");
  assert.deepEqual(adapter.cancelledExecutionIds, ["exec-123"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildAntigravityInvocation } from "../../src/v4/adapters/antigravity/command";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";

const dummyReq: StepRequest = {
  runId: asRunId("run-1"),
  stepId: asStepId("step-1"),
  phase: "EXECUTE",
  operationId: "op-1",
  workspaceDir: "/my/workspace",
  prompt: "build UI component",
  requiredCapabilities: ["workspace.read", "workspace.write"],
  sideEffect: "workspace-write",
  timeoutMs: 60000,
};

test("antigravity-command: buildAntigravityInvocation in safe workspace-write mode", () => {
  const invocation = buildAntigravityInvocation({
    request: dummyReq,
    mode: "workspace-write",
    outcomeJsonSchema: { type: "object" },
    printTimeoutMs: 30000,
  });

  assert.equal(invocation.command, "agy");
  assert.ok(invocation.args.includes("--sandbox"));
  assert.ok(invocation.args.includes("--mode"));
  assert.ok(invocation.args.includes("accept-edits"));
  assert.ok(invocation.args.includes("--add-dir"));
  assert.ok(invocation.args.includes("/my/workspace"));
  assert.ok(invocation.args.includes("--output-format"));
  assert.ok(invocation.args.includes("json"));
  assert.ok(invocation.args.includes("--print-timeout"));
  assert.ok(invocation.args.includes("30s"));
  assert.ok(invocation.args.includes("--print"));
  assert.ok(!invocation.args.includes("--dangerously-skip-permissions"));
});

test("antigravity-command: buildAntigravityInvocation elevated mode contains bypass flag", () => {
  const invocation = buildAntigravityInvocation({
    request: dummyReq,
    mode: "elevated",
    outcomeJsonSchema: { type: "object" },
    printTimeoutMs: 30000,
  });

  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.ok(!invocation.args.includes("--sandbox"));
});

test("antigravity-command: buildAntigravityInvocation supports optional model flag", () => {
  const invocation = buildAntigravityInvocation({
    request: dummyReq,
    mode: "workspace-write",
    outcomeJsonSchema: { type: "object" },
    printTimeoutMs: 30000,
    model: "gemini-2.5-pro",
  });

  assert.ok(invocation.args.includes("--model"));
  assert.ok(invocation.args.includes("gemini-2.5-pro"));
});

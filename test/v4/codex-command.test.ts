import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexInvocation } from "../../src/v4/adapters/codex/command";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";

const dummyReq: StepRequest = {
  runId: asRunId("run-1"),
  stepId: asStepId("step-1"),
  phase: "EXECUTE",
  operationId: "op-1",
  workspaceDir: "/my/workspace",
  prompt: "implement feature X",
  requiredCapabilities: ["workspace.read", "workspace.write"],
  sideEffect: "workspace-write",
  timeoutMs: 5000,
};

test("codex-command: workspace-write uses approve-for-me without conflicting sandbox flag", () => {
  const invocation = buildCodexInvocation({
    request: dummyReq,
    mode: "workspace-write",
    schemaPath: "/tmp/schema.json",
    resultPath: "/tmp/result.json",
  });

  assert.equal(invocation.command, "codex");
  assert.ok(invocation.args.includes("exec"));
  assert.ok(invocation.args.includes("--json"));
  assert.ok(invocation.args.includes("--strict-config"));
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("--output-schema"));
  assert.ok(invocation.args.includes("--output-last-message"));
  assert.ok(invocation.args.includes("--approve-for-me"));
  assert.ok(!invocation.args.includes("--sandbox"));
  assert.ok(!invocation.args.includes("workspace-write"));
  assert.ok(invocation.args.includes("/my/workspace"));
  assert.ok(!invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(invocation.stdin?.includes("implement feature X"));
});

test("codex-command: buildCodexInvocation in read-only mode omits approve-for-me", () => {
  const invocation = buildCodexInvocation({
    request: { ...dummyReq, sideEffect: "read-only" },
    mode: "read-only",
    schemaPath: "/tmp/schema.json",
    resultPath: "/tmp/result.json",
  });

  assert.ok(invocation.args.includes("read-only"));
  assert.ok(!invocation.args.includes("--approve-for-me"));
  assert.ok(!invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("codex-command: buildCodexInvocation in elevated mode adds bypass flag", () => {
  const invocation = buildCodexInvocation({
    request: dummyReq,
    mode: "elevated",
    schemaPath: "/tmp/schema.json",
    resultPath: "/tmp/result.json",
  });

  assert.ok(invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!invocation.args.includes("--sandbox"));
  assert.ok(!invocation.args.includes("--approve-for-me"));
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeInvocation,
  DEFAULT_CLAUDE_TOOL_POLICY,
} from "../../src/v4/adapters/claude/command";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";

const dummyReq: StepRequest = {
  runId: asRunId("run-1"),
  stepId: asStepId("step-1"),
  phase: "EXECUTE",
  operationId: "op-1",
  workspaceDir: "/my/workspace",
  prompt: "fix issue in core",
  requiredCapabilities: ["workspace.read", "workspace.write"],
  sideEffect: "workspace-write",
  timeoutMs: 5000,
};

test("claude-command: buildClaudeInvocation safe workspace-write mode", () => {
  const invocation = buildClaudeInvocation({
    request: dummyReq,
    mode: "workspace-write",
    outcomeJsonSchema: { type: "object" },
    toolPolicy: DEFAULT_CLAUDE_TOOL_POLICY,
    newSessionId: "uuid-1234",
  });

  assert.equal(invocation.command, "claude");
  assert.ok(invocation.args.includes("--print"));
  assert.ok(invocation.args.includes("--output-format"));
  assert.ok(invocation.args.includes("json"));
  assert.ok(invocation.args.includes("--permission-mode"));
  assert.ok(invocation.args.includes("acceptEdits"));
  assert.ok(invocation.args.includes("--allowedTools"));
  assert.ok(invocation.args.includes("--session-id"));
  assert.ok(invocation.args.includes("uuid-1234"));
  assert.ok(!invocation.args.includes("--dangerously-skip-permissions"));
});

test("claude-command: buildClaudeInvocation elevated mode contains bypass flag", () => {
  const invocation = buildClaudeInvocation({
    request: dummyReq,
    mode: "elevated",
    outcomeJsonSchema: { type: "object" },
    toolPolicy: DEFAULT_CLAUDE_TOOL_POLICY,
    newSessionId: "uuid-1234",
  });

  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.ok(!invocation.args.includes("--permission-mode"));
  assert.ok(!invocation.args.includes("--allowedTools"));
});

test("claude-command: buildClaudeInvocation resume mode uses --resume", () => {
  const invocation = buildClaudeInvocation({
    request: dummyReq,
    mode: "workspace-write",
    outcomeJsonSchema: { type: "object" },
    toolPolicy: DEFAULT_CLAUDE_TOOL_POLICY,
    newSessionId: "uuid-1234",
    resumeSessionId: "session-prev",
  });

  assert.ok(invocation.args.includes("--resume"));
  assert.ok(invocation.args.includes("session-prev"));
  assert.ok(!invocation.args.includes("--session-id"));
});

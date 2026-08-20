import test from "node:test";
import assert from "node:assert/strict";
import { renderAgentPrompt } from "../../src/v4/adapters/shared/prompt";
import {
  resolvePermissionMode,
  AdapterPolicyError,
} from "../../src/v4/adapters/shared/permission-mode";
import { createAgentStepOutcomeJsonSchema } from "../../src/v4/adapters/shared/result-schema";
import {
  processFailure,
  malformedOutputFailure,
} from "../../src/v4/adapters/shared/adapter-failure";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";
import { StepResultSchema } from "../../src/v4/contracts/step-result";

const dummyReq: StepRequest = {
  runId: asRunId("run-1"),
  stepId: asStepId("step-1"),
  phase: "EXECUTE",
  operationId: "op-1",
  workspaceDir: "/workspace",
  prompt: 'write "hello world" & test metachars',
  requiredCapabilities: ["workspace.read", "workspace.write"],
  sideEffect: "workspace-write",
  timeoutMs: 5000,
};

test("adapter-shared: renderAgentPrompt produces compact structured task", () => {
  const prompt = renderAgentPrompt(dummyReq);
  assert.ok(prompt.includes("[OMNI-V4 CONTROL PROTOCOL]"));
  assert.ok(prompt.includes('"executionId":"op-1"'));
  assert.ok(prompt.includes('"stepId":"step-1"'));
  assert.ok(prompt.includes('"workspaceDir":"/workspace"'));
});

test("adapter-shared: resolvePermissionMode rules", () => {
  // read-only
  const roMode = resolvePermissionMode(
    { ...dummyReq, sideEffect: "read-only" },
    { signal: new AbortController().signal, elevatedPermissions: false }
  );
  assert.equal(roMode, "read-only");

  // workspace-write
  const wwMode = resolvePermissionMode(
    { ...dummyReq, sideEffect: "workspace-write" },
    { signal: new AbortController().signal, elevatedPermissions: false }
  );
  assert.equal(wwMode, "workspace-write");

  // elevated explicit
  const elevatedMode = resolvePermissionMode(dummyReq, {
    signal: new AbortController().signal,
    elevatedPermissions: true,
  });
  assert.equal(elevatedMode, "elevated");

  // external without elevated throws AdapterPolicyError
  assert.throws(
    () =>
      resolvePermissionMode(
        { ...dummyReq, sideEffect: "external" },
        { signal: new AbortController().signal, elevatedPermissions: false }
      ),
    AdapterPolicyError
  );
});

test("adapter-shared: createAgentStepOutcomeJsonSchema is valid and rejects native", () => {
  const schema = createAgentStepOutcomeJsonSchema();
  assert.equal(schema.title, "AgentStepOutcome");
  assert.ok(Array.isArray(schema.oneOf));
  // Ensure no variant includes 'native' in required or properties
  for (const variant of schema.oneOf as any[]) {
    assert.equal(variant.properties.native, undefined);
  }
});

test("adapter-shared: failure builders produce valid StepResult with stable signatures", () => {
  const procFail = processFailure({
    executionId: "op-1",
    hostId: "codex",
    code: "CLI_EXIT",
    message: "exit code 1",
    retryable: true,
  });
  const parsed1 = StepResultSchema.parse(procFail);
  assert.equal(parsed1.status, "failed");
  if (parsed1.status === "failed") {
    assert.equal(parsed1.failure.signature, "codex:cli_exit");
  }

  const malformed = malformedOutputFailure("op-1", "claude", "invalid JSON syntax");
  const parsed2 = StepResultSchema.parse(malformed);
  assert.equal(parsed2.status, "failed");
  if (parsed2.status === "failed") {
    assert.equal(parsed2.failure.signature, "claude:malformed_output");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultPolicy } from "../../src/v4/policy/default-policy";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { AdapterProbe, StepRequest } from "../../src/v4/contracts/adapter";

const dummyRequest: StepRequest = {
  runId: asRunId("run-1"),
  stepId: asStepId("step-1"),
  phase: "INTAKE",
  operationId: "op-1",
  workspaceDir: "/workspace",
  prompt: "do something",
  requiredCapabilities: ["workspace.read", "structured-output"],
  sideEffect: "read-only",
  timeoutMs: 5000,
};

const dummyProbe: AdapterProbe = {
  available: true,
  adapterId: "fake",
  capabilities: ["workspace.read", "structured-output"],
  diagnostics: [],
};

test("policy: preflight checks capability and elevation", () => {
  const defaultPolicy = createDefaultPolicy();

  // Allowed case
  const allowRes = defaultPolicy.evaluatePreflight({
    request: dummyRequest,
    probe: dummyProbe,
    elevatedPermissions: false,
  });
  assert.equal(allowRes.kind, "allow");

  // Missing capability -> deny
  const missingCapProbe: AdapterProbe = {
    ...dummyProbe,
    capabilities: ["workspace.read"], // missing structured-output
  };
  const denyCapRes = defaultPolicy.evaluatePreflight({
    request: dummyRequest,
    probe: missingCapProbe,
    elevatedPermissions: false,
  });
  assert.equal(denyCapRes.kind, "deny");

  // Elevated permissions denied by default
  const denyElevated = defaultPolicy.evaluatePreflight({
    request: dummyRequest,
    probe: dummyProbe,
    elevatedPermissions: true,
  });
  assert.equal(denyElevated.kind, "deny");

  // Elevated permissions allowed when configured
  const elevatedPolicy = createDefaultPolicy({ allowElevatedPermissions: true });
  const allowElevated = elevatedPolicy.evaluatePreflight({
    request: dummyRequest,
    probe: dummyProbe,
    elevatedPermissions: true,
  });
  assert.equal(allowElevated.kind, "allow");
});

test("policy: failure decisions for retryable, identical, and non-retryable errors", () => {
  const policy = createDefaultPolicy({
    maxRetriesPerStep: 2,
    maxSameFailureCount: 2,
    retryDelayMs: 0,
  });

  // Non-retryable -> block immediately
  const blockNonRetryable = policy.decideFailure({
    request: dummyRequest,
    failure: {
      code: "SYNTAX_ERROR",
      message: "bad code",
      retryable: false,
      signature: "syntax_err",
    },
    attempt: 1,
    sameFailureCount: 1,
  });
  assert.equal(blockNonRetryable.kind, "block");

  // Retryable first failure -> retry
  const retryFirst = policy.decideFailure({
    request: dummyRequest,
    failure: {
      code: "TIMEOUT",
      message: "timed out",
      retryable: true,
      signature: "timeout_sig",
    },
    attempt: 1,
    sameFailureCount: 1,
  });
  assert.equal(retryFirst.kind, "retry");

  // Retryable second identical failure -> block (maxSameFailureCount is 2)
  const blockIdentical = policy.decideFailure({
    request: dummyRequest,
    failure: {
      code: "TIMEOUT",
      message: "timed out again",
      retryable: true,
      signature: "timeout_sig",
    },
    attempt: 2,
    sameFailureCount: 2,
  });
  assert.equal(blockIdentical.kind, "block");
});

test("policy: resume decision protects workspace-write and external operations", () => {
  const policy = createDefaultPolicy();

  // read-only -> retry
  const readOnlyResume = policy.decideResume({
    runId: asRunId("run-1"),
    phase: "INTAKE",
    stepId: asStepId("step-1"),
    operationId: "op-1",
    sideEffect: "read-only",
    attempt: 1,
  });
  assert.equal(readOnlyResume.kind, "retry");

  // workspace-write -> block
  const writeResume = policy.decideResume({
    runId: asRunId("run-1"),
    phase: "EXECUTE",
    stepId: asStepId("step-2"),
    operationId: "op-2",
    sideEffect: "workspace-write",
    attempt: 1,
  });
  assert.equal(writeResume.kind, "block");

  // external -> block
  const externalResume = policy.decideResume({
    runId: asRunId("run-1"),
    phase: "EXECUTE",
    stepId: asStepId("step-3"),
    operationId: "op-3",
    sideEffect: "external",
    attempt: 1,
  });
  assert.equal(externalResume.kind, "block");
});

test("policy: rejects unknown configuration keys", () => {
  assert.throws(() =>
    createDefaultPolicy({
      allowElevatedPermissions: true,
      // @ts-expect-error test unknown property rejection
      unknownField: 123,
    })
  );
});

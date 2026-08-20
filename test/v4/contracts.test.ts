import test from "node:test";
import assert from "node:assert/strict";
import { V4_SCHEMA_VERSION } from "../../src/v4/index";
import {
  AgentStepOutcomeSchema,
  StepResultSchema,
  ArtifactClaimSchema,
  ArtifactRecordSchema,
  EvidenceSchema,
  AdapterProbeSchema,
  RunEventSchema,
  asArtifactId,
  asEventId,
  asRunId,
  asStepId,
  type StepResult,
  type RunEvent,
} from "../../src/v4/contracts";

test("v4 exports schema version 1", () => {
  assert.equal(V4_SCHEMA_VERSION, 1);
});

test("StepResultSchema accepts a complete success", () => {
  const result = StepResultSchema.parse({
    status: "succeeded",
    executionId: "exec-1",
    summary: "wrote one file",
    artifacts: [],
    evidence: [],
  }) satisfies StepResult;
  assert.equal(result.status, "succeeded");
});

test("StepResultSchema rejects prose-only success", () => {
  assert.throws(() => StepResultSchema.parse({ ok: true, summary: "done" }));
});

test("AgentStepOutcomeSchema rejects adapter-owned native metadata", () => {
  assert.throws(() =>
    AgentStepOutcomeSchema.parse({
      status: "succeeded",
      executionId: "exec-1",
      summary: "done",
      artifacts: [],
      evidence: [],
      native: { sessionId: "fabricated" },
    })
  );
});

test("StepResultSchema permits adapter-derived native metadata", () => {
  const parsed = StepResultSchema.parse({
    status: "succeeded",
    executionId: "exec-1",
    summary: "done",
    artifacts: [],
    evidence: [],
    native: { sessionId: "sess-123", usage: { totalTokens: 100 } },
  });
  assert.equal(parsed.native?.sessionId, "sess-123");
});

test("StepResultSchema rejects failure without a stable signature", () => {
  assert.throws(() =>
    StepResultSchema.parse({
      status: "failed",
      executionId: "exec-1",
      failure: { code: "CLI_EXIT", message: "failed", retryable: true },
    })
  );
});

test("ArtifactClaimSchema rejects absolute paths and .. escaping", () => {
  assert.throws(() =>
    ArtifactClaimSchema.parse({
      artifactId: "art-1",
      kind: "file",
      relativePath: "/etc/passwd",
    })
  );
  assert.throws(() =>
    ArtifactClaimSchema.parse({
      artifactId: "art-1",
      kind: "file",
      relativePath: "foo/../../bar",
    })
  );
  assert.throws(() =>
    ArtifactClaimSchema.parse({
      artifactId: "art-1",
      kind: "file",
      relativePath: "C:\\windows\\system32",
    })
  );
});

test("AdapterProbeSchema accepts valid probe and rejects invalid capabilities", () => {
  const probe = AdapterProbeSchema.parse({
    available: true,
    adapterId: "fake",
    capabilities: ["workspace.read", "workspace.write"],
    diagnostics: [],
  });
  assert.equal(probe.available, true);
  assert.throws(() =>
    AdapterProbeSchema.parse({
      available: true,
      adapterId: "fake",
      capabilities: ["unknown.capability"],
      diagnostics: [],
    })
  );
});

test("RunEventSchema accepts valid step.started event", () => {
  const event = RunEventSchema.parse({
    schemaVersion: 1,
    eventId: "evt-1",
    runId: "run-1",
    sequence: 1,
    at: "2026-08-20T10:00:00.000Z",
    type: "step.started",
    payload: {
      stepId: "step-1",
      operationId: "op-1",
      phase: "INTAKE",
      sideEffect: "read-only",
      workspaceDir: "/workspace",
    },
  }) satisfies RunEvent;
  assert.equal(event.type, "step.started");
});

test("RunEventSchema rejects negative sequence and unknown event type", () => {
  assert.throws(() =>
    RunEventSchema.parse({
      schemaVersion: 1,
      eventId: "evt-1",
      runId: "run-1",
      sequence: -1,
      at: "2026-08-20T10:00:00.000Z",
      type: "step.started",
      payload: {
        stepId: "step-1",
        operationId: "op-1",
        phase: "INTAKE",
        sideEffect: "read-only",
        workspaceDir: "/workspace",
      },
    })
  );

  assert.throws(() =>
    RunEventSchema.parse({
      schemaVersion: 1,
      eventId: "evt-1",
      runId: "run-1",
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "unknown.type",
      payload: {},
    })
  );
});

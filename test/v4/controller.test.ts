import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { RunController } from "../../src/v4/core/controller";
import { createDefaultPolicy } from "../../src/v4/policy/default-policy";
import { FileEventStore } from "../../src/v4/storage/event-store";
import { FileArtifactStore } from "../../src/v4/storage/artifact-store";
import { FakeAdapter } from "../../src/v4/testing/fake-adapter";
import { asArtifactId, asEventId, asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest, AgentAdapter, AdapterProbe, AdapterContext } from "../../src/v4/contracts/adapter";

function createTestController(projectDir: string, fakeAdapter: AgentAdapter, policy = createDefaultPolicy()) {
  let eventSeq = 0;
  return new RunController({
    adapter: fakeAdapter,
    policy,
    events: new FileEventStore({ projectDir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });
}

test("controller: success path produces exact durable event order and advances phase", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-succ-"));
  try {
    const runId = asRunId("run-1");
    const stepId = asStepId("step-1");
    const opId = "op-1";

    const filePath = path.join(tmpdir, "output.txt");
    const fileContent = "success artifact\n";
    await fs.writeFile(filePath, fileContent, "utf-8");

    const fakeAdapter = new FakeAdapter({
      outcomes: [
        {
          kind: "return",
          value: {
            status: "succeeded",
            executionId: opId,
            summary: "created output.txt",
            artifacts: [
              {
                artifactId: asArtifactId("art-1"),
                kind: "file",
                relativePath: "output.txt",
              },
            ],
            evidence: [
              {
                schemaVersion: 1,
                kind: "artifact",
                producerStepId: stepId,
                method: "write",
                startedAt: "2026-08-20T10:00:00.000Z",
                durationMs: 50,
                artifactIds: [asArtifactId("art-1")],
                summary: "wrote output.txt",
              },
            ],
          },
        },
      ],
    });

    const controller = createTestController(tmpdir, fakeAdapter);
    const startState = await controller.start({ runId });
    assert.equal(startState.phase, "INTAKE");

    const req: StepRequest = {
      runId,
      stepId,
      phase: "INTAKE",
      operationId: opId,
      workspaceDir: tmpdir,
      prompt: "generate output.txt",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "workspace-write",
      timeoutMs: 5000,
    };

    const finalState = await controller.executeNext(req);
    assert.equal(finalState.phase, "PLAN");
    assert.equal(finalState.attempt, 1);

    const events = await new FileEventStore({ projectDir: tmpdir }).read(runId);
    const eventTypes = events.map((e) => e.type);

    assert.deepEqual(eventTypes, [
      "run.created",
      "policy.decided",
      "step.started",
      "artifact.recorded",
      "step.succeeded",
      "run.transitioned",
    ]);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("controller: preflight policy denial blocks without step.started or execution", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-deny-"));
  try {
    const runId = asRunId("run-2");
    const fakeAdapter = new FakeAdapter({
      capabilities: ["workspace.read"],
      outcomes: [], // Adapter should NOT be called
    });

    const controller = createTestController(tmpdir, fakeAdapter);
    await controller.start({ runId });

    const req: StepRequest = {
      runId,
      stepId: asStepId("s-1"),
      phase: "INTAKE",
      operationId: "op-1",
      workspaceDir: tmpdir,
      prompt: "require shell",
      requiredCapabilities: ["shell"], // missing in adapter probe
      sideEffect: "read-only",
      timeoutMs: 5000,
    };

    const state = await controller.executeNext(req);
    assert.equal(state.phase, "BLOCKED");
    assert.equal(fakeAdapter.calls.length, 0);

    const events = await new FileEventStore({ projectDir: tmpdir }).read(runId);
    const eventTypes = events.map((e) => e.type);
    assert.deepEqual(eventTypes, ["run.created", "policy.decided", "run.blocked"]);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("controller: unavailable adapter probe produces policy deny and blocks without adapter calls", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-unavail-"));
  try {
    const runId = asRunId("run-unavail");
    const fakeAdapter = new FakeAdapter({
      available: false,
      outcomes: [],
    });

    const controller = createTestController(tmpdir, fakeAdapter);
    await controller.start({ runId });

    const req: StepRequest = {
      runId,
      stepId: asStepId("s-1"),
      phase: "INTAKE",
      operationId: "op-1",
      workspaceDir: tmpdir,
      prompt: "run",
      requiredCapabilities: [], // no capabilities required
      sideEffect: "read-only",
      timeoutMs: 5000,
    };

    const state = await controller.executeNext(req);
    assert.equal(state.phase, "BLOCKED");
    assert.equal(fakeAdapter.calls.length, 0);

    const events = await new FileEventStore({ projectDir: tmpdir }).read(runId);
    const eventTypes = events.map((e) => e.type);
    assert.deepEqual(eventTypes, ["run.created", "policy.decided", "run.blocked"]);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("controller: authoritative deadline settles timeout and invokes cancel exactly once", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-timeout-"));
  try {
    const runId = asRunId("run-timeout");
    let cancelCalls = 0;

    // Adapter that ignores AbortSignal and hangs forever
    const hangingAdapter: AgentAdapter = {
      id: "fake",
      async probe(): Promise<AdapterProbe> {
        return {
          adapterId: "fake",
          available: true,
          capabilities: ["workspace.read"],
          diagnostics: [],
        };
      },
      async execute(_req: StepRequest, _ctx: AdapterContext): Promise<any> {
        return new Promise(() => {}); // Never resolves
      },
      async cancel(_operationId: string): Promise<void> {
        cancelCalls++;
      },
    };

    const controller = createTestController(tmpdir, hangingAdapter);
    await controller.start({ runId });

    const req: StepRequest = {
      runId,
      stepId: asStepId("s-1"),
      phase: "INTAKE",
      operationId: "op-1",
      workspaceDir: tmpdir,
      prompt: "hang",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read-only",
      timeoutMs: 50, // Short 50ms deadline
    };

    const start = Date.now();
    const state = await controller.executeNext(req);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `Execution took ${elapsed}ms; should have timed out within bounded time`);
    assert.equal(cancelCalls, 1);
    assert.equal(state.attempt, 2); // retry attempt tracked
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("controller: non-success outcome records failure and applies policy retry", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-fail-"));
  try {
    const runId = asRunId("run-3");
    const fakeAdapter = new FakeAdapter({
      outcomes: [
        {
          kind: "return",
          value: {
            status: "failed",
            executionId: "op-1",
            failure: {
              code: "COMPILE_ERROR",
              message: "syntax error",
              retryable: true,
              signature: "compile_err",
            },
          },
        },
      ],
    });

    const controller = createTestController(tmpdir, fakeAdapter);
    await controller.start({ runId });

    const req: StepRequest = {
      runId,
      stepId: asStepId("s-1"),
      phase: "INTAKE",
      operationId: "op-1",
      workspaceDir: tmpdir,
      prompt: "run",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read-only",
      timeoutMs: 5000,
    };

    const state = await controller.executeNext(req);
    assert.equal(state.phase, "INTAKE"); // remains in INTAKE for retry
    assert.equal(state.attempt, 2);
    assert.equal(state.lastFailureSignature, "compile_err");

    const events = await new FileEventStore({ projectDir: tmpdir }).read(runId);
    const eventTypes = events.map((e) => e.type);
    assert.deepEqual(eventTypes, [
      "run.created",
      "policy.decided",
      "step.started",
      "step.failed",
      "policy.decided",
    ]);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

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
import type { RunEvent } from "../../src/v4/contracts/event";

function createTestController(projectDir: string, fakeAdapter: FakeAdapter) {
  let eventSeq = 0;
  return new RunController({
    adapter: fakeAdapter,
    policy: createDefaultPolicy(),
    events: new FileEventStore({ projectDir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });
}

test("recovery: read-only step inFlight recovers with rerun directive and no adapter calls", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-recv-ro-"));
  try {
    const runId = asRunId("run-ro");
    const eventStore = new FileEventStore({ projectDir: tmpdir });

    // Seed events ending after step.started
    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-0"),
        runId,
        sequence: 0,
        at: "2026-08-20T10:00:00.000Z",
        type: "run.created",
        payload: { startedAt: "2026-08-20T10:00:00.000Z" },
      },
      -1
    );

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-1"),
        runId,
        sequence: 1,
        at: "2026-08-20T10:00:01.000Z",
        type: "step.started",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          phase: "INTAKE",
          sideEffect: "read-only",
          workspaceDir: tmpdir,
        },
      },
      0
    );

    const fakeAdapter = new FakeAdapter({ outcomes: [] });
    const controller = createTestController(tmpdir, fakeAdapter);

    const resumeResult = await controller.resume(runId);
    assert.equal(resumeResult.kind, "rerun");
    if (resumeResult.kind === "rerun") {
      assert.equal(resumeResult.previousOperationId, "op-1");
      assert.equal(resumeResult.state.inFlight, undefined);
    }
    assert.equal(fakeAdapter.calls.length, 0);

    const events = await eventStore.read(runId);
    const eventTypes = events.map((e) => e.type);
    assert.deepEqual(eventTypes, [
      "run.created",
      "step.started",
      "step.interrupted",
      "policy.decided",
    ]);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("recovery: workspace-write step inFlight recovers as blocked with no adapter calls", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-recv-ww-"));
  try {
    const runId = asRunId("run-ww");
    const eventStore = new FileEventStore({ projectDir: tmpdir });

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-0"),
        runId,
        sequence: 0,
        at: "2026-08-20T10:00:00.000Z",
        type: "run.created",
        payload: { startedAt: "2026-08-20T10:00:00.000Z" },
      },
      -1
    );

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-1"),
        runId,
        sequence: 1,
        at: "2026-08-20T10:00:01.000Z",
        type: "step.started",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          phase: "EXECUTE",
          sideEffect: "workspace-write",
          workspaceDir: tmpdir,
        },
      },
      0
    );

    const fakeAdapter = new FakeAdapter({ outcomes: [] });
    const controller = createTestController(tmpdir, fakeAdapter);

    const resumeResult = await controller.resume(runId);
    assert.equal(resumeResult.kind, "blocked");
    if (resumeResult.kind === "blocked") {
      assert.equal(resumeResult.state.phase, "BLOCKED");
    }
    assert.equal(fakeAdapter.calls.length, 0);

    const events = await eventStore.read(runId);
    const eventTypes = events.map((e) => e.type);
    assert.deepEqual(eventTypes, [
      "run.created",
      "step.started",
      "step.interrupted",
      "policy.decided",
      "run.blocked",
    ]);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("recovery: step.succeeded without run.transitioned rolls forward safely", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-recv-rollfwd-"));
  try {
    const runId = asRunId("run-rf");
    const eventStore = new FileEventStore({ projectDir: tmpdir });

    const filePath = path.join(tmpdir, "doc.md");
    const content = "my doc\n";
    await fs.writeFile(filePath, content, "utf-8");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-0"),
        runId,
        sequence: 0,
        at: "2026-08-20T10:00:00.000Z",
        type: "run.created",
        payload: { startedAt: "2026-08-20T10:00:00.000Z" },
      },
      -1
    );

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-1"),
        runId,
        sequence: 1,
        at: "2026-08-20T10:00:01.000Z",
        type: "step.started",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          phase: "INTAKE",
          sideEffect: "workspace-write",
          workspaceDir: tmpdir,
        },
      },
      0
    );

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-2"),
        runId,
        sequence: 2,
        at: "2026-08-20T10:00:02.000Z",
        type: "artifact.recorded",
        payload: {
          record: {
            schemaVersion: 1,
            artifactId: asArtifactId("art-1"),
            runId,
            producerStepId: asStepId("s-1"),
            kind: "file",
            relativePath: "doc.md",
            sha256,
            sizeBytes: Buffer.byteLength(content),
            recordedAt: "2026-08-20T10:00:02.000Z",
          },
        },
      },
      1
    );

    await eventStore.append(
      {
        schemaVersion: 1,
        eventId: asEventId("e-3"),
        runId,
        sequence: 3,
        at: "2026-08-20T10:00:03.000Z",
        type: "step.succeeded",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          result: {
            status: "succeeded",
            executionId: "op-1",
            summary: "wrote doc",
            artifacts: [
              {
                artifactId: asArtifactId("art-1"),
                kind: "file",
                relativePath: "doc.md",
              },
            ],
            evidence: [
              {
                schemaVersion: 1,
                kind: "artifact",
                producerStepId: asStepId("s-1"),
                method: "write",
                startedAt: "2026-08-20T10:00:01.000Z",
                durationMs: 50,
                artifactIds: [asArtifactId("art-1")],
                summary: "wrote doc",
              },
            ],
          },
        },
      },
      2
    );

    const fakeAdapter = new FakeAdapter({ outcomes: [] });
    const controller = createTestController(tmpdir, fakeAdapter);

    const resumeResult = await controller.resume(runId);
    assert.equal(resumeResult.kind, "continue");
    if (resumeResult.kind === "continue") {
      assert.equal(resumeResult.state.phase, "PLAN");
    }

    const events = await eventStore.read(runId);
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent?.type, "run.transitioned");
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

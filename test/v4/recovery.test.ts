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
import type { StepRequest } from "../../src/v4/contracts/adapter";

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
          phase: "INTAKE",
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

test("recovery: re-verifies recorded artifacts after run.transitioned and blocks tampering", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-recv-transition-tamper-"));
  try {
    const runId = asRunId("run-transition-tamper");
    const stepId = asStepId("step-transition-tamper");
    const artifactId = asArtifactId("artifact-transition-tamper");
    const artifactPath = path.join(tmpdir, "output.txt");
    await fs.writeFile(artifactPath, "trusted content\n", "utf-8");

    const adapter = new FakeAdapter({
      outcomes: [
        {
          kind: "return",
          value: {
            status: "succeeded",
            executionId: "op-transition-tamper",
            summary: "created output",
            artifacts: [{ artifactId, kind: "file", relativePath: "output.txt" }],
            evidence: [
              {
                schemaVersion: 1,
                kind: "artifact",
                producerStepId: stepId,
                method: "write",
                startedAt: "2026-08-20T10:00:00.000Z",
                durationMs: 1,
                artifactIds: [artifactId],
                summary: "verified output",
              },
            ],
          },
        },
      ],
    });
    const controller = createTestController(tmpdir, adapter);
    await controller.start({ runId });

    const request: StepRequest = {
      runId,
      stepId,
      phase: "INTAKE",
      operationId: "op-transition-tamper",
      workspaceDir: tmpdir,
      prompt: "create output",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "workspace-write",
      timeoutMs: 5000,
    };
    const transitioned = await controller.executeNext(request);
    assert.equal(transitioned.phase, "PLAN");

    await fs.writeFile(artifactPath, "tampered content\n", "utf-8");

    const resumeResult = await controller.resume(runId);
    assert.equal(resumeResult.kind, "blocked");
    if (resumeResult.kind === "blocked") {
      assert.equal(resumeResult.state.phase, "BLOCKED");
      assert.match(resumeResult.reason, /Artifact verification failed/);
    }

    const events = await new FileEventStore({ projectDir: tmpdir }).read(runId);
    assert.equal(events.at(-1)?.type, "run.blocked");
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("recovery: re-verifies recorded artifacts before trusting READY", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-recv-ready-tamper-"));
  try {
    const runId = asRunId("run-ready-tamper");
    const phases = ["INTAKE", "PLAN", "EXECUTE", "VERIFY", "ACCEPT", "DOCUMENT"] as const;
    for (const phase of phases) {
      await fs.writeFile(path.join(tmpdir, `${phase}.txt`), `${phase}\n`, "utf-8");
    }

    const adapter = new FakeAdapter({
      outcomes: phases.map((phase, index) => ({
        kind: "return" as const,
        value: {
          status: "succeeded",
          executionId: `op-ready-${index}`,
          summary: `completed ${phase}`,
          artifacts: [
            {
              artifactId: asArtifactId(`artifact-ready-${index}`),
              kind: "file",
              relativePath: `${phase}.txt`,
            },
          ],
          evidence: [
            {
              schemaVersion: 1,
              kind: "artifact",
              producerStepId: asStepId(`step-ready-${index}`),
              method: "write",
              startedAt: "2026-08-20T10:00:00.000Z",
              durationMs: 1,
              artifactIds: [asArtifactId(`artifact-ready-${index}`)],
              summary: `verified ${phase}`,
            },
          ],
        },
      })),
    });
    const controller = createTestController(tmpdir, adapter);
    await controller.start({ runId });

    for (const [index, phase] of phases.entries()) {
      await controller.executeNext({
        runId,
        stepId: asStepId(`step-ready-${index}`),
        phase,
        operationId: `op-ready-${index}`,
        workspaceDir: tmpdir,
        prompt: `complete ${phase}`,
        requiredCapabilities: ["workspace.read"],
        sideEffect: "workspace-write",
        timeoutMs: 5000,
      });
    }
    assert.equal((await controller.getState(runId)).phase, "READY");

    await fs.writeFile(path.join(tmpdir, "INTAKE.txt"), "tampered after ready\n", "utf-8");
    const resumeResult = await controller.resume(runId);
    assert.equal(resumeResult.kind, "blocked");
    if (resumeResult.kind === "blocked") {
      assert.equal(resumeResult.state.phase, "BLOCKED");
    }
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

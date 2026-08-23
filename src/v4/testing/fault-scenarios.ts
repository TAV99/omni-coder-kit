import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { asArtifactId, asEventId, asRunId, asStepId, type RunId } from "../contracts/ids";
import type { RunPhase } from "../contracts/run";
import type { RunEventType } from "../contracts/event";
import { RunController } from "../core/controller";
import { createDefaultPolicy } from "../policy/default-policy";
import { FileArtifactStore } from "../storage/artifact-store";
import { FileEventStore } from "../storage/event-store";
import { FakeAdapter } from "./fake-adapter";

export interface FaultScenarioFixture {
  readonly name: string;
  readonly projectDir: string;
  readonly runId: RunId;
  readonly expectedTerminalPhase: RunPhase;
  readonly transitionAllowed: boolean;
  readonly expectedMaxAdapterCalls: number;
  readonly run: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

async function createBaseProject(name: string) {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), `omni-v4-fault-${name}-`));
  const runId = asRunId(`run-${name}`);
  return {
    tmpdir,
    runId,
    cleanup: async () => {
      await fs.rm(tmpdir, { recursive: true, force: true });
    },
  };
}

export async function providerThrow(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("throw");
  const adapter = new FakeAdapter({
    outcomes: [{ kind: "throw", error: new Error("Network timeout") }],
  });
  let eventSeq = 0;
  const controller = new RunController({
    adapter,
    policy: createDefaultPolicy({ maxRetriesPerStep: 0 }),
    events: new FileEventStore({ projectDir: tmpdir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "providerThrow",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 1,
    run: async () => {
      await controller.start({ runId });
      await controller.executeNext({
        runId,
        stepId: asStepId("s-1"),
        phase: "INTAKE",
        operationId: "op-1",
        workspaceDir: tmpdir,
        prompt: "do task",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read-only",
        timeoutMs: 5000,
      });
    },
    cleanup,
  };
}

export async function providerTimeout(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("timeout");
  const adapter = new FakeAdapter({
    outcomes: [{ kind: "wait-for-abort" }],
  });
  let eventSeq = 0;
  const controller = new RunController({
    adapter,
    policy: createDefaultPolicy({ maxRetriesPerStep: 0 }),
    events: new FileEventStore({ projectDir: tmpdir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "providerTimeout",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 1,
    run: async () => {
      await controller.start({ runId });
      await controller.executeNext({
        runId,
        stepId: asStepId("s-1"),
        phase: "INTAKE",
        operationId: "op-1",
        workspaceDir: tmpdir,
        prompt: "do task",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read-only",
        timeoutMs: 50,
      });
    },
    cleanup,
  };
}

export async function malformedSuccess(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("malformed");
  const adapter = new FakeAdapter({
    outcomes: [{ kind: "return", value: { status: "succeeded", badField: true } }],
  });
  let eventSeq = 0;
  const controller = new RunController({
    adapter,
    policy: createDefaultPolicy({ maxRetriesPerStep: 0 }),
    events: new FileEventStore({ projectDir: tmpdir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "malformedSuccess",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 1,
    run: async () => {
      await controller.start({ runId });
      await controller.executeNext({
        runId,
        stepId: asStepId("s-1"),
        phase: "INTAKE",
        operationId: "op-1",
        workspaceDir: tmpdir,
        prompt: "do task",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read-only",
        timeoutMs: 5000,
      });
    },
    cleanup,
  };
}

export async function missingArtifact(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("missing-art");
  const adapter = new FakeAdapter({
    outcomes: [
      {
        kind: "return",
        value: {
          status: "succeeded",
          executionId: "op-1",
          summary: "claims to have written file",
          artifacts: [
            {
              artifactId: asArtifactId("art-1"),
              kind: "file",
              relativePath: "ghost.txt",
            },
          ],
          evidence: [
            {
              schemaVersion: 1,
              kind: "artifact",
              producerStepId: asStepId("s-1"),
              method: "write",
              startedAt: "2026-08-20T10:00:00.000Z",
              durationMs: 10,
              artifactIds: [asArtifactId("art-1")],
              summary: "evidence",
            },
          ],
        },
      },
    ],
  });
  let eventSeq = 0;
  const controller = new RunController({
    adapter,
    policy: createDefaultPolicy({ maxRetriesPerStep: 0 }),
    events: new FileEventStore({ projectDir: tmpdir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "missingArtifact",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 1,
    run: async () => {
      await controller.start({ runId });
      await controller.executeNext({
        runId,
        stepId: asStepId("s-1"),
        phase: "INTAKE",
        operationId: "op-1",
        workspaceDir: tmpdir,
        prompt: "do task",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "workspace-write",
        timeoutMs: 5000,
      });
    },
    cleanup,
  };
}

export async function modifiedArtifact(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("mod-art");
  const eventStore = new FileEventStore({ projectDir: tmpdir });
  const filePath = path.join(tmpdir, "file.txt");
  await fs.writeFile(filePath, "original content", "utf-8");

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
          relativePath: "file.txt",
          sha256: crypto.createHash("sha256").update("original content").digest("hex"),
          sizeBytes: 16,
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
          summary: "wrote file",
          artifacts: [
            {
              artifactId: asArtifactId("art-1"),
              kind: "file",
              relativePath: "file.txt",
            },
          ],
          evidence: [
            {
              schemaVersion: 1,
              kind: "artifact",
              producerStepId: asStepId("s-1"),
              method: "write",
              startedAt: "2026-08-20T10:00:01.000Z",
              durationMs: 10,
              artifactIds: [asArtifactId("art-1")],
              summary: "evidence",
            },
          ],
        },
      },
    },
    2
  );

  // Tamper with file before recovery
  await fs.writeFile(filePath, "tampered content", "utf-8");

  let eventSeq = 3;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "modifiedArtifact",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function truncatedEventLog(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("trunc-log");
  const eventsDir = path.join(tmpdir, ".omni", "v4", "runs", runId);
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(path.join(eventsDir, "events.ndjson"), '{"schemaVersion":1, "eventId": "e-1"', "utf-8");

  let eventSeq = 0;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: new FileEventStore({ projectDir: tmpdir }),
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "truncatedEventLog",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      try {
        await controller.resume(runId);
      } catch {
        // Expected reject
      }
    },
    cleanup,
  };
}

export async function duplicateEvent(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("dup-event");
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

  return {
    name: "duplicateEvent",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "INTAKE",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      try {
        await eventStore.append(
          {
            schemaVersion: 1,
            eventId: asEventId("e-0"), // duplicate
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
      } catch {
        // Expected reject
      }
    },
    cleanup,
  };
}

export async function crashAfterStepStartedReadOnly(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-ro");
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
        sideEffect: "read-only",
        workspaceDir: tmpdir,
      },
    },
    0
  );

  let eventSeq = 1;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterStepStartedReadOnly",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "INTAKE",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      const res = await controller.resume(runId);
      if (res.kind !== "rerun") {
        throw new Error(`Expected rerun, got ${res.kind}`);
      }
    },
    cleanup,
  };
}

export async function crashAfterStepStartedWorkspaceWrite(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-ww");
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

  let eventSeq = 1;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterStepStartedWorkspaceWrite",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterStepStartedExternal(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-ext");
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
        sideEffect: "external",
        workspaceDir: tmpdir,
      },
    },
    0
  );

  let eventSeq = 1;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterStepStartedExternal",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterArtifactRecorded(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-art-rec");
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
          relativePath: "out.txt",
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          sizeBytes: 0,
          recordedAt: "2026-08-20T10:00:02.000Z",
        },
      },
    },
    1
  );

  let eventSeq = 2;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterArtifactRecorded",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterStepSucceeded(): Promise<FaultScenarioFixture> {
  return modifiedArtifact(); // Re-use roll-forward check
}

export async function crashAfterStepFailed(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-failed");
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
        sideEffect: "read-only",
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
      type: "step.failed",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        result: {
          status: "failed",
          executionId: "op-1",
          failure: {
            code: "SYNTAX",
            message: "syntax error",
            retryable: false,
            signature: "syntax",
          },
        },
      },
    },
    1
  );

  let eventSeq = 2;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterStepFailed",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterRetryDecision(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-retry-dec");
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
        sideEffect: "read-only",
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
      type: "step.interrupted",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        reason: "crash",
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
      type: "policy.decided",
      payload: {
        stage: "resume",
        stepId: asStepId("s-1"),
        operationId: "op-1",
        decision: { kind: "retry", delayMs: 0 },
      },
    },
    2
  );

  let eventSeq = 3;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterRetryDecision",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "INTAKE",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      const res = await controller.resume(runId);
      if (res.kind !== "rerun") {
        throw new Error(`Unexpected resume result: expected 'rerun', got '${res.kind}'`);
      }
    },
    cleanup,
  };
}

export async function crashAfterBlockDecision(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-block-dec");
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
        sideEffect: "read-only",
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
      type: "step.failed",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        result: {
          status: "failed",
          executionId: "op-1",
          failure: {
            code: "ERR",
            message: "fatal",
            retryable: false,
            signature: "fatal",
          },
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
      type: "policy.decided",
      payload: {
        stage: "failure",
        stepId: asStepId("s-1"),
        operationId: "op-1",
        decision: {
          kind: "block",
          reason: "fatal",
          requiredAction: "manual fix",
        },
      },
    },
    2
  );

  let eventSeq = 3;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterBlockDecision",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterStepBlocked(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-step-blocked");
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
        sideEffect: "read-only",
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
      type: "step.blocked",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        reason: "blocked by user",
      },
    },
    1
  );

  let eventSeq = 2;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterStepBlocked",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "BLOCKED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterStepCancelled(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-step-cancel");
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
        sideEffect: "read-only",
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
      type: "step.cancelled",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        reason: "cancelled by user",
      },
    },
    1
  );

  let eventSeq = 2;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterStepCancelled",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "CANCELLED",
    transitionAllowed: false,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      await controller.resume(runId);
    },
    cleanup,
  };
}

export async function crashAfterRunTransitioned(): Promise<FaultScenarioFixture> {
  const { tmpdir, runId, cleanup } = await createBaseProject("crash-trans");
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
        sideEffect: "read-only",
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
      type: "step.succeeded",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        result: {
          status: "succeeded",
          executionId: "op-1",
          summary: "done",
          artifacts: [],
          evidence: [],
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
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        from: "INTAKE",
        to: "PLAN",
        causedByEventId: asEventId("e-2"),
      },
    },
    2
  );

  let eventSeq = 3;
  const controller = new RunController({
    adapter: new FakeAdapter({ outcomes: [] }),
    policy: createDefaultPolicy(),
    events: eventStore,
    artifacts: new FileArtifactStore(),
    now: () => new Date().toISOString(),
    newEventId: () => asEventId(`evt-${++eventSeq}-${crypto.randomUUID()}`),
  });

  return {
    name: "crashAfterRunTransitioned",
    projectDir: tmpdir,
    runId,
    expectedTerminalPhase: "PLAN",
    transitionAllowed: true,
    expectedMaxAdapterCalls: 0,
    run: async () => {
      const res = await controller.resume(runId);
      if (res.kind !== "continue") {
        throw new Error(`Expected continue, got ${res.kind}`);
      }
    },
    cleanup,
  };
}

export const faultScenarios = {
  providerThrow,
  providerTimeout,
  malformedSuccess,
  missingArtifact,
  modifiedArtifact,
  truncatedEventLog,
  duplicateEvent,
  crashAfterStepStartedReadOnly,
  crashAfterStepStartedWorkspaceWrite,
  crashAfterStepStartedExternal,
  crashAfterArtifactRecorded,
  crashAfterStepSucceeded,
  crashAfterStepFailed,
  crashAfterRetryDecision,
  crashAfterBlockDecision,
  crashAfterStepBlocked,
  crashAfterStepCancelled,
  crashAfterRunTransitioned,
} as const;

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  FileEventStore,
  replayRun,
  CorruptEventLogError,
  EventSequenceConflictError,
} from "../../src/v4/storage/event-store";
import { asEventId, asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { RunEvent } from "../../src/v4/contracts/event";

test("event-store: append, read, and replay lifecycle", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-evt-"));
  try {
    const store = new FileEventStore({ projectDir: tmpdir });
    const runId = asRunId("run-1");

    const event0: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: {
        startedAt: "2026-08-20T10:00:00.000Z",
      },
    };

    await store.append(event0, -1);

    const event1: RunEvent = {
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
        workspaceDir: "/workspace",
      },
    };

    await store.append(event1, 0);

    const events = await store.read(runId);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "run.created");
    assert.equal(events[1]?.type, "step.started");

    const replayed = replayRun(events);
    assert.equal(replayed.sequence, 1);
    assert.equal(replayed.phase, "INTAKE");
    assert.equal(replayed.inFlight?.stepId, "s-1");
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("event-store: sequence conflict and duplicate ID detection", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-evt-conflict-"));
  try {
    const store = new FileEventStore({ projectDir: tmpdir });
    const runId = asRunId("run-2");

    const event0: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    };

    // Expected sequence mismatch on initial append
    await assert.rejects(
      store.append(event0, 0), // expected -1, not 0
      EventSequenceConflictError
    );

    await store.append(event0, -1);

    // Duplicate eventId
    const dupEvent: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-0"), // duplicate ID
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:01.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        phase: "INTAKE",
        sideEffect: "read-only",
        workspaceDir: "/workspace",
      },
    };

    await assert.rejects(store.append(dupEvent, 0), EventSequenceConflictError);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("event-store: concurrent appends with same expectedSequence resolve with one success and one conflict", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-evt-conc-"));
  try {
    const store = new FileEventStore({ projectDir: tmpdir });
    const runId = asRunId("run-3");

    const event0: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    };

    await store.append(event0, -1);

    const event1A: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-1a"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:01.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1a",
        phase: "INTAKE",
        sideEffect: "read-only",
        workspaceDir: "/workspace",
      },
    };

    const event1B: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-1b"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:01.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1b",
        phase: "INTAKE",
        sideEffect: "read-only",
        workspaceDir: "/workspace",
      },
    };

    // Both attempt expectedSequence = 0 concurrently
    const results = await Promise.allSettled([
      store.append(event1A, 0),
      store.append(event1B, 0),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0] && (rejected[0] as PromiseRejectedResult).reason instanceof EventSequenceConflictError);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("event-store: corrupt log line raises CorruptEventLogError", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-evt-corrupt-"));
  try {
    const store = new FileEventStore({ projectDir: tmpdir });
    const runId = asRunId("run-4");
    const eventsDir = path.join(tmpdir, ".omni", "v4", "runs", "run-4");
    await fs.mkdir(eventsDir, { recursive: true });
    const eventsFile = path.join(eventsDir, "events.ndjson");

    await fs.writeFile(eventsFile, '{"valid": false}\n', "utf-8");

    await assert.rejects(store.read(runId), CorruptEventLogError);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

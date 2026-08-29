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

test("event-store: multi-instance concurrent append race on same file resolves with exactly 1 success and 1 conflict", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-multi-inst-"));
  try {
    const store1 = new FileEventStore({ projectDir: tmpdir });
    const store2 = new FileEventStore({ projectDir: tmpdir });
    const runId = asRunId("run-multi");

    const event0: RunEvent = {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    };

    await store1.append(event0, -1);

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

    // store1 and store2 are separate instances attempting the same sequence 0
    const results = await Promise.allSettled([
      store1.append(event1A, 0),
      store2.append(event1B, 0),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0] &&
        (rejected[0] as PromiseRejectedResult).reason instanceof
          EventSequenceConflictError
    );
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("event-store: replayRun rejects cross-run events and forged transition causes", () => {
  const runA = asRunId("run-a");
  const runB = asRunId("run-b");

  const event0: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-0"),
    runId: runA,
    sequence: 0,
    at: "2026-08-20T10:00:00.000Z",
    type: "run.created",
    payload: { startedAt: "2026-08-20T10:00:00.000Z" },
  };

  // Cross-run event
  const crossRunEvent: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-1"),
    runId: runB, // wrong runId
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

  assert.throws(
    () => replayRun([event0, crossRunEvent]),
    CorruptEventLogError
  );

  // Forged transition with nonexistent cause
  const forgedTransition: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-1"),
    runId: runA,
    sequence: 1,
    at: "2026-08-20T10:00:01.000Z",
    type: "run.transitioned",
    payload: {
      stepId: asStepId("s-1"),
      operationId: "op-1",
      from: "INTAKE",
      to: "PLAN",
      causedByEventId: asEventId("non-existent-cause"),
    },
  };

  assert.throws(
    () => replayRun([event0, forgedTransition]),
    CorruptEventLogError
  );
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

test("event-store: filesystem faults preserve the last durable log", async () => {
  const faults = [
    { name: "temp-write-ENOSPC", hook: "beforeTempWrite", code: "ENOSPC" },
    { name: "temp-sync-EIO", hook: "beforeTempSync", code: "EIO" },
    { name: "rename-EIO", hook: "beforeRename", code: "EIO" },
  ] as const;

  for (const fault of faults) {
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), `omni-v4-evt-${fault.name}-`));
    try {
      const runId = asRunId("run-enospc");
      const durableStore = new FileEventStore({ projectDir: tmpdir });
      const created: RunEvent = {
        schemaVersion: 1,
        eventId: asEventId("e-0"),
        runId,
        sequence: 0,
        at: "2026-08-20T10:00:00.000Z",
        type: "run.created",
        payload: { startedAt: "2026-08-20T10:00:00.000Z" },
      };
      await durableStore.append(created, -1);

      const fail = () => {
        const err = new Error(`filesystem fault ${fault.name}`);
        (err as NodeJS.ErrnoException).code = fault.code;
        throw err;
      };
      const faultStore = new FileEventStore({
        projectDir: tmpdir,
        fsHooks: {
          ...(fault.hook === "beforeTempWrite" ? { beforeTempWrite: fail } : {}),
          ...(fault.hook === "beforeTempSync" ? { beforeTempSync: fail } : {}),
          ...(fault.hook === "beforeRename" ? { beforeRename: fail } : {}),
        },
      });
      const started: RunEvent = {
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
      };

      await assert.rejects(faultStore.append(started, 0), new RegExp(fault.name));
      const durableEvents = await durableStore.read(runId);
      assert.deepEqual(durableEvents.map((event) => event.type), ["run.created"]);
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true });
    }
  }
});

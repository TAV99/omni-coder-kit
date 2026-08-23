import test from "node:test";
import assert from "node:assert/strict";
import {
  asRunId,
  asEventId,
  asStepId,
  asQualityCycleId,
  type RunEvent,
} from "../../src/v4/contracts";
import { replayRun, CorruptEventLogError } from "../../src/v4/storage/event-store";

test("route_causation", () => {
  const runId = asRunId("run-quality-1");
  const cycleId = asQualityCycleId("cycle-1");

  const events: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("e-0"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    },
    // INTAKE -> PLAN
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
        workspaceDir: process.cwd(),
      },
    },
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
          summary: "Step 1 completed",
          artifacts: [],
          evidence: [],
        },
      },
    },
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
    // PLAN -> EXECUTE
    {
      schemaVersion: 1,
      eventId: asEventId("e-4"),
      runId,
      sequence: 4,
      at: "2026-08-20T10:00:04.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-2"),
        operationId: "op-2",
        phase: "PLAN",
        sideEffect: "read-only",
        workspaceDir: process.cwd(),
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-5"),
      runId,
      sequence: 5,
      at: "2026-08-20T10:00:05.000Z",
      type: "step.succeeded",
      payload: {
        stepId: asStepId("s-2"),
        operationId: "op-2",
        result: {
          status: "succeeded",
          executionId: "op-2",
          summary: "Step 2 completed",
          artifacts: [],
          evidence: [],
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-6"),
      runId,
      sequence: 6,
      at: "2026-08-20T10:00:06.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-2"),
        operationId: "op-2",
        from: "PLAN",
        to: "EXECUTE",
        causedByEventId: asEventId("e-5"),
      },
    },
    // EXECUTE -> VERIFY
    {
      schemaVersion: 1,
      eventId: asEventId("e-7"),
      runId,
      sequence: 7,
      at: "2026-08-20T10:00:07.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("s-3"),
        operationId: "op-3",
        phase: "EXECUTE",
        sideEffect: "workspace-write",
        workspaceDir: process.cwd(),
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-8"),
      runId,
      sequence: 8,
      at: "2026-08-20T10:00:08.000Z",
      type: "step.succeeded",
      payload: {
        stepId: asStepId("s-3"),
        operationId: "op-3",
        result: {
          status: "succeeded",
          executionId: "op-3",
          summary: "Step 3 completed",
          artifacts: [],
          evidence: [],
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-9"),
      runId,
      sequence: 9,
      at: "2026-08-20T10:00:09.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-3"),
        operationId: "op-3",
        from: "EXECUTE",
        to: "VERIFY",
        causedByEventId: asEventId("e-8"),
      },
    },
    // VERIFY -> quality.started -> quality.completed -> run.routed to ACCEPT
    {
      schemaVersion: 1,
      eventId: asEventId("e-10"),
      runId,
      sequence: 10,
      at: "2026-08-20T10:00:10.000Z",
      type: "quality.started",
      payload: {
        cycleId,
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:10.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-11"),
      runId,
      sequence: 11,
      at: "2026-08-20T10:00:11.000Z",
      type: "quality.completed",
      payload: {
        cycleId,
        decision: { kind: "advance", to: "ACCEPT" },
        completedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-12"),
      runId,
      sequence: 12,
      at: "2026-08-20T10:00:12.000Z",
      type: "run.routed",
      payload: {
        from: "VERIFY",
        to: "ACCEPT",
        causedByEventId: asEventId("e-11"),
      },
    },
  ];

  const state = replayRun(events);
  assert.equal(state.phase, "ACCEPT");
  assert.equal(state.sequence, 12);
});

test("rejects_invalid_cause", () => {
  const runId = asRunId("run-quality-2");
  const ev0 = asEventId("e-0");
  const ev1 = asEventId("e-1");

  const events: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: ev0,
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: ev1,
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:01.000Z",
      type: "run.routed",
      payload: {
        from: "INTAKE",
        to: "PLAN",
        causedByEventId: asEventId("non-existent-quality-event"),
      },
    },
  ];

  assert.throws(() => replayRun(events), CorruptEventLogError);
});

test("replays_legacy_logs", () => {
  const runId = asRunId("run-legacy");
  const ev0 = asEventId("e-0");
  const ev1 = asEventId("e-1");
  const ev2 = asEventId("e-2");
  const ev3 = asEventId("e-3");

  const events: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: ev0,
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "run.created",
      payload: { startedAt: "2026-08-20T10:00:00.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: ev1,
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:01.000Z",
      type: "step.started",
      payload: {
        stepId: asStepId("step-1"),
        operationId: "op-1",
        phase: "INTAKE",
        sideEffect: "read-only",
        workspaceDir: process.cwd(),
      },
    },
    {
      schemaVersion: 1,
      eventId: ev2,
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:02.000Z",
      type: "step.succeeded",
      payload: {
        stepId: asStepId("step-1"),
        operationId: "op-1",
        result: {
          status: "succeeded",
          executionId: "op-1",
          summary: "Step 1 completed",
          artifacts: [],
          evidence: [],
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: ev3,
      runId,
      sequence: 3,
      at: "2026-08-20T10:00:03.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("step-1"),
        operationId: "op-1",
        from: "INTAKE",
        to: "PLAN",
        causedByEventId: ev2,
      },
    },
  ];

  const state = replayRun(events);
  assert.equal(state.phase, "PLAN");
  assert.equal(state.sequence, 3);
});

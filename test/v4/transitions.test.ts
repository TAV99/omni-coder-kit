import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedTransition,
  nextPhaseOnSuccess,
  successTransitions,
  TransitionError,
} from "../../src/v4/core/transitions";
import {
  createInitialState,
  reduceEvent,
  EventSequenceError,
  InvalidStateError,
} from "../../src/v4/core/reducer";
import { RUN_PHASES, type RunPhase } from "../../src/v4/contracts/run";
import { asArtifactId, asEventId, asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { RunEvent } from "../../src/v4/contracts/event";

test("transitions: table-driven normal-success transitions", () => {
  for (const [from, to] of successTransitions) {
    assert.equal(nextPhaseOnSuccess(from), to);
    assert.equal(isAllowedTransition(from, to), true);
  }

  // Non-success phases throw TransitionError
  assert.throws(() => nextPhaseOnSuccess("READY"), TransitionError);
  assert.throws(() => nextPhaseOnSuccess("BLOCKED"), TransitionError);
  assert.throws(() => nextPhaseOnSuccess("CANCELLED"), TransitionError);

  // Unlisted pairs return false
  assert.equal(isAllowedTransition("INTAKE", "EXECUTE"), false);
  assert.equal(isAllowedTransition("PLAN", "READY"), false);
  assert.equal(isAllowedTransition("READY", "INTAKE"), false);
});

test("transitions: exhaustive check of all pairs", () => {
  const allowedSet = new Set(successTransitions.map(([f, t]) => `${f}->${t}`));
  for (const from of RUN_PHASES) {
    for (const to of RUN_PHASES) {
      const isAllowed = isAllowedTransition(from, to);
      assert.equal(isAllowed, allowedSet.has(`${from}->${to}`));
    }
  }
});

test("reducer: step lifecycle and state mutations", () => {
  const runId = asRunId("run-1");
  const stepId = asStepId("step-1");
  const eventId = (seq: number) => asEventId(`evt-${seq}`);

  // Initial state
  const state0 = createInitialState({
    runId,
    startedAt: "2026-08-20T10:00:00.000Z",
  });
  assert.equal(state0.sequence, 0);
  assert.equal(state0.phase, "INTAKE");
  assert.equal(state0.attempt, 1);
  assert.equal(state0.inFlight, undefined);

  // step.started
  const event1: RunEvent = {
    schemaVersion: 1,
    eventId: eventId(1),
    runId,
    sequence: 1,
    at: "2026-08-20T10:00:01.000Z",
    type: "step.started",
    payload: {
      stepId,
      operationId: "op-1",
      phase: "INTAKE",
      sideEffect: "read-only",
      workspaceDir: "/workspace",
    },
  };
  const state1 = reduceEvent(state0, event1);
  assert.equal(state1.sequence, 1);
  assert.equal(state1.phase, "INTAKE");
  assert.deepEqual(state1.inFlight, {
    stepId,
    operationId: "op-1",
    sideEffect: "read-only",
  });

  // artifact.recorded does not mutate phase or inFlight
  const event2: RunEvent = {
    schemaVersion: 1,
    eventId: eventId(2),
    runId,
    sequence: 2,
    at: "2026-08-20T10:00:02.000Z",
    type: "artifact.recorded",
    payload: {
      record: {
        schemaVersion: 1,
        artifactId: asArtifactId("art-1"),
        runId,
        producerStepId: stepId,
        kind: "file",
        relativePath: "out.txt",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: 0,
        recordedAt: "2026-08-20T10:00:02.000Z",
      },
    },
  };
  const state2 = reduceEvent(state1, event2);
  assert.equal(state2.sequence, 2);
  assert.equal(state2.phase, "INTAKE");
  assert.equal(state2.inFlight?.stepId, stepId);

  // step.succeeded clears inFlight
  const event3: RunEvent = {
    schemaVersion: 1,
    eventId: eventId(3),
    runId,
    sequence: 3,
    at: "2026-08-20T10:00:03.000Z",
    type: "step.succeeded",
    payload: {
      stepId,
      operationId: "op-1",
      result: {
        status: "succeeded",
        executionId: "op-1",
        summary: "done",
        artifacts: [
          {
            artifactId: asArtifactId("art-1"),
            kind: "file",
            relativePath: "out.txt",
          },
        ],
        evidence: [
          {
            schemaVersion: 1,
            kind: "artifact",
            producerStepId: stepId,
            method: "write",
            startedAt: "2026-08-20T10:00:01.000Z",
            durationMs: 100,
            artifactIds: [asArtifactId("art-1")],
            summary: "wrote out.txt",
          },
        ],
      },
    },
  };
  const state3 = reduceEvent(state2, event3);
  assert.equal(state3.sequence, 3);
  assert.equal(state3.phase, "INTAKE");
  assert.equal(state3.inFlight, undefined);

  // run.transitioned changes phase
  const event4: RunEvent = {
    schemaVersion: 1,
    eventId: eventId(4),
    runId,
    sequence: 4,
    at: "2026-08-20T10:00:04.000Z",
    type: "run.transitioned",
    payload: {
      stepId,
      operationId: "op-1",
      from: "INTAKE",
      to: "PLAN",
      causedByEventId: eventId(3),
    },
  };
  const state4 = reduceEvent(state3, event4);
  assert.equal(state4.sequence, 4);
  assert.equal(state4.phase, "PLAN");
  assert.equal(state4.attempt, 1);
});

test("reducer: step.failed increments attempt and tracks failure signatures", () => {
  const runId = asRunId("run-2");
  const stepId = asStepId("step-1");
  const state0 = createInitialState({
    runId,
    startedAt: "2026-08-20T10:00:00.000Z",
  });

  const start1: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-1"),
    runId,
    sequence: 1,
    at: "2026-08-20T10:00:01.000Z",
    type: "step.started",
    payload: {
      stepId,
      operationId: "op-1",
      phase: "INTAKE",
      sideEffect: "read-only",
      workspaceDir: "/w",
    },
  };
  const state1 = reduceEvent(state0, start1);

  const fail1: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-2"),
    runId,
    sequence: 2,
    at: "2026-08-20T10:00:02.000Z",
    type: "step.failed",
    payload: {
      stepId,
      operationId: "op-1",
      result: {
        status: "failed",
        executionId: "op-1",
        failure: {
          code: "TIMEOUT",
          message: "timed out",
          retryable: true,
          signature: "timeout-sig",
        },
      },
    },
  };
  const state2 = reduceEvent(state1, fail1);
  assert.equal(state2.attempt, 2);
  assert.equal(state2.sameFailureCount, 1);
  assert.equal(state2.lastFailureSignature, "timeout-sig");

  // Retry with same failure signature
  const start2: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-3"),
    runId,
    sequence: 3,
    at: "2026-08-20T10:00:03.000Z",
    type: "step.started",
    payload: {
      stepId,
      operationId: "op-2",
      phase: "INTAKE",
      sideEffect: "read-only",
      workspaceDir: "/w",
    },
  };
  const state3 = reduceEvent(state2, start2);

  const fail2: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-4"),
    runId,
    sequence: 4,
    at: "2026-08-20T10:00:04.000Z",
    type: "step.failed",
    payload: {
      stepId,
      operationId: "op-2",
      result: {
        status: "failed",
        executionId: "op-2",
        failure: {
          code: "TIMEOUT",
          message: "timed out again",
          retryable: true,
          signature: "timeout-sig",
        },
      },
    },
  };
  const state4 = reduceEvent(state3, fail2);
  assert.equal(state4.attempt, 3);
  assert.equal(state4.sameFailureCount, 2);
  assert.equal(state4.lastFailureSignature, "timeout-sig");
});

test("reducer: non-consecutive sequence throws EventSequenceError", () => {
  const runId = asRunId("run-3");
  const state0 = createInitialState({
    runId,
    startedAt: "2026-08-20T10:00:00.000Z",
  });
  const skipSeqEvent: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-2"),
    runId,
    sequence: 2,
    at: "2026-08-20T10:00:01.000Z",
    type: "step.started",
    payload: {
      stepId: asStepId("s-1"),
      operationId: "op-1",
      phase: "INTAKE",
      sideEffect: "read-only",
      workspaceDir: "/w",
    },
  };
  assert.throws(() => reduceEvent(state0, skipSeqEvent), EventSequenceError);
});

test("reducer: run.blocked and run.cancelled transition properly", () => {
  const runId = asRunId("run-4");
  const state0 = createInitialState({
    runId,
    startedAt: "2026-08-20T10:00:00.000Z",
  });

  const blockEvent: RunEvent = {
    schemaVersion: 1,
    eventId: asEventId("e-1"),
    runId,
    sequence: 1,
    at: "2026-08-20T10:00:01.000Z",
    type: "run.blocked",
    payload: {
      reason: "elevated permissions denied",
      requiredAction: "grant permission in config",
      causedByEventId: asEventId("e-0"),
    },
  };
  const state1 = reduceEvent(state0, blockEvent);
  assert.equal(state1.phase, "BLOCKED");

  // Cannot apply further events after terminal/blocked phase
  assert.throws(
    () =>
      reduceEvent(state1, {
        schemaVersion: 1,
        eventId: asEventId("e-2"),
        runId,
        sequence: 2,
        at: "2026-08-20T10:00:02.000Z",
        type: "run.cancelled",
        payload: {
          reason: "stop",
          causedByEventId: asEventId("e-1"),
        },
      }),
    InvalidStateError
  );
});

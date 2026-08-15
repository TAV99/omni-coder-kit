import test from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../../src/v4/state/reducer";
import type { RunEvent } from "../../src/v4/contracts/events";
import { asEventId, asRunId, asStepId } from "../../src/v4/contracts/ids";

test("reducer: valid sequences produce expected state", () => {
  const ts = new Date().toISOString();
  
  const ev1: RunEvent = {
    type: "RunStarted",
    eventId: asEventId("e1"),
    runId: asRunId("r1"),
    sequence: 0,
    timestamp: ts,
    initialPhase: "PLAN"
  };
  
  const state1 = reduce(null, ev1);
  assert.equal(state1.sequence, 0);
  assert.equal(state1.phase, "PLAN");
  assert.equal(state1.attempt, 1);
  
  const ev2: RunEvent = {
    type: "StepStarted",
    eventId: asEventId("e2"),
    runId: asRunId("r1"),
    sequence: 1,
    timestamp: ts,
    stepId: asStepId("s1")
  };
  
  const state2 = reduce(state1, ev2);
  assert.equal(state2.sequence, 1);
  assert.ok(state2.inFlight);
  assert.equal(state2.inFlight.stepId, "s1");
});

test("reducer: gap sequences throw an error", () => {
  const ts = new Date().toISOString();
  const ev1: RunEvent = {
    type: "RunStarted",
    eventId: asEventId("e1"),
    runId: asRunId("r1"),
    sequence: 0,
    timestamp: ts,
    initialPhase: "PLAN"
  };
  const state1 = reduce(null, ev1);
  
  const ev3: RunEvent = {
    type: "StepStarted",
    eventId: asEventId("e3"),
    runId: asRunId("r1"),
    sequence: 2, // gap!
    timestamp: ts,
    stepId: asStepId("s1")
  };
  
  assert.throws(() => reduce(state1, ev3), /Sequence gap: expected 1, got 2/);
});

test("reducer: invalid transitions throw an error", () => {
  const ts = new Date().toISOString();
  const ev1: RunEvent = {
    type: "RunStarted",
    eventId: asEventId("e1"),
    runId: asRunId("r1"),
    sequence: 0,
    timestamp: ts,
    initialPhase: "CANCELLED" // Start in CANCELLED for test
  };
  const state1 = reduce(null, ev1);
  
  const ev2: RunEvent = {
    type: "StepStarted",
    eventId: asEventId("e2"),
    runId: asRunId("r1"),
    sequence: 1,
    timestamp: ts,
    stepId: asStepId("s1")
  };
  
  assert.throws(() => reduce(state1, ev2), /cannot occur in terminal phase/);
});

test("reducer: inFlight is correctly managed", () => {
  const ts = new Date().toISOString();
  let state = reduce(null, {
    type: "RunStarted",
    eventId: asEventId("e1"),
    runId: asRunId("r1"),
    sequence: 0,
    timestamp: ts,
    initialPhase: "EXECUTE"
  });
  
  state = reduce(state, {
    type: "StepStarted",
    eventId: asEventId("e2"),
    runId: asRunId("r1"),
    sequence: 1,
    timestamp: ts,
    stepId: asStepId("s1")
  });
  
  assert.ok(state.inFlight);
  
  state = reduce(state, {
    type: "StepCompleted",
    eventId: asEventId("e3"),
    runId: asRunId("r1"),
    sequence: 2,
    timestamp: ts,
    stepId: asStepId("s1"),
    result: {
      status: "succeeded",
      executionId: "exec1",
      summary: "done",
      artifacts: [],
      evidence: []
    }
  });
  
  assert.equal(state.inFlight, undefined);
});

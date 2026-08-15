import test from "node:test";
import assert from "node:assert/strict";
import { RunEventSchema, type RunEvent } from "../../src/v4/contracts/events";

test("RunEventSchema accepts a valid RunStarted event", () => {
  const event = RunEventSchema.parse({
    type: "RunStarted",
    eventId: "evt-1",
    runId: "run-1",
    sequence: 0,
    timestamp: new Date().toISOString(),
    initialPhase: "INTAKE",
  }) satisfies RunEvent;
  assert.equal(event.type, "RunStarted");
});

test("RunEventSchema rejects unknown types", () => {
  assert.throws(() => RunEventSchema.parse({
    type: "UnknownEvent",
    eventId: "evt-1",
    runId: "run-1",
    sequence: 0,
    timestamp: new Date().toISOString(),
  }));
});

test("RunEventSchema rejects missing fields", () => {
  assert.throws(() => RunEventSchema.parse({
    type: "RunStarted",
    eventId: "evt-1",
    // missing runId, sequence, timestamp, initialPhase
  }));
});

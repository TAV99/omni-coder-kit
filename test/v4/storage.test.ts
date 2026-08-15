import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventStorage } from "../../src/v4/storage/events";
import { asEventId, asRunId } from "../../src/v4/contracts/ids";
import type { RunEvent } from "../../src/v4/contracts/events";

test("EventStorage appends and replays events", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-test-"));
  
  try {
    const storage = new EventStorage(tmpdir);
    
    // initially replay returns null
    const initial = await storage.replay();
    assert.equal(initial, null);
    
    const ts = new Date().toISOString();
    
    const ev1: RunEvent = {
      type: "RunStarted",
      eventId: asEventId("e1"),
      runId: asRunId("r1"),
      sequence: 0,
      timestamp: ts,
      initialPhase: "PLAN"
    };
    
    await storage.append(ev1);
    
    const state1 = await storage.replay();
    assert.ok(state1);
    assert.equal(state1.sequence, 0);
    assert.equal(state1.phase, "PLAN");
    
    const ev2: RunEvent = {
      type: "RunPhaseChanged",
      eventId: asEventId("e2"),
      runId: asRunId("r1"),
      sequence: 1,
      timestamp: ts,
      phase: "EXECUTE"
    };
    
    await storage.append(ev2);
    
    const state2 = await storage.replay();
    assert.ok(state2);
    assert.equal(state2.sequence, 1);
    assert.equal(state2.phase, "EXECUTE");
    
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

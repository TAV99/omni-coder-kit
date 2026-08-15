import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RunController } from "../../src/v4/controller/run";
import { FakeAdapter } from "../../src/v4/adapters/fake";
import { DefaultSafetyPolicy } from "../../src/v4/policy/default";
import { EventStorage } from "../../src/v4/storage/events";
import { ArtifactStorage } from "../../src/v4/storage/artifacts";
import { asRunId, asEventId, asStepId, asArtifactId } from "../../src/v4/contracts/ids";
import type { RunEvent } from "../../src/v4/contracts/events";

test("RunController recovers from inFlight crash", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-recv-"));
  try {
    const runId = asRunId("r1");
    const eventStorage = new EventStorage(tmpdir);
    const artifactStorage = new ArtifactStorage(tmpdir);
    
    await eventStorage.append({
      type: "RunStarted",
      eventId: asEventId("e1"),
      runId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      initialPhase: "EXECUTE"
    });
    
    await eventStorage.append({
      type: "StepStarted",
      eventId: asEventId("e2"),
      runId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      stepId: asStepId("s1")
    });
    
    // Missing StepCompleted!
    
    const adapter = new FakeAdapter([
      {
        status: "succeeded",
        executionId: "exec1",
        summary: "did work after recovery",
        artifacts: [{ artifactId: asArtifactId("a1"), kind: "file", relativePath: "test.txt" }],
        evidence: [] 
      }
    ]);
    const fileContent = "dummy";
    const filePath = path.join(tmpdir, "test.txt");
    await fs.writeFile(filePath, fileContent);
    
    const controller = new RunController(runId, adapter, DefaultSafetyPolicy, eventStorage, artifactStorage);
    
    const state = await controller.advance();
    
    // Events: 0(Started), 1(StepStarted), 2(Recovery Crash Completed), 3(StepStarted), 4(StepCompleted)
    assert.equal(state.sequence, 4);
    assert.equal(state.attempt, 2); // crash was attempt 1, new execution is attempt 2
    assert.equal(state.inFlight, undefined);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

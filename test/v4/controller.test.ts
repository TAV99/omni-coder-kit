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
import { asRunId, asEventId, asArtifactId } from "../../src/v4/contracts/ids";
import type { StepResult } from "../../src/v4/contracts/step-result";
import type { RunEvent } from "../../src/v4/contracts/events";

test("RunController.advance correctly processes a step", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-"));
  try {
    const runId = asRunId("r1");
    const eventStorage = new EventStorage(tmpdir);
    const artifactStorage = new ArtifactStorage(tmpdir);
    
    // Seed with RunStarted
    const runStarted: RunEvent = {
      type: "RunStarted",
      eventId: asEventId("e1"),
      runId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      initialPhase: "EXECUTE"
    };
    await eventStorage.append(runStarted);
    
    const fileContent = "dummy";
    const filePath = path.join(tmpdir, "test.txt");
    await fs.writeFile(filePath, fileContent);

    const stepRes: StepResult = {
      status: "succeeded",
      executionId: "exec1",
      summary: "did work",
      artifacts: [{ artifactId: asArtifactId("a1"), kind: "file", relativePath: "test.txt" }],
      evidence: []
    };
    const adapter = new FakeAdapter([stepRes]);
    
    const controller = new RunController(runId, adapter, DefaultSafetyPolicy, eventStorage, artifactStorage);
    
    const state = await controller.advance();
    
    assert.equal(state.sequence, 2); // sequence 1 was StepStarted, 2 was StepCompleted
    assert.equal(state.inFlight, undefined);
    assert.equal(state.attempt, 1);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test("RunController.advance halts on policy violation", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-ctrl-viol-"));
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
    
    // Suceeded but no artifacts -> fails default safety policy
    const stepRes: StepResult = {
      status: "succeeded",
      executionId: "exec1",
      summary: "did work",
      artifacts: [],
      evidence: []
    };
    const adapter = new FakeAdapter([stepRes]);
    
    const controller = new RunController(runId, adapter, DefaultSafetyPolicy, eventStorage, artifactStorage);
    
    const state = await controller.advance();
    
    // It should have recorded StepCompleted as a failure
    assert.equal(state.sequence, 2);
    // Because it's a failure, attempt increments
    assert.equal(state.attempt, 2);
    assert.equal(state.lastFailureSignature, "policy_violation");
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

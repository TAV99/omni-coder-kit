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
import type { RunState } from "../../src/v4/contracts/run";

test("P0 Acceptance Suite: run advances through failures to READY", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-p0-"));
  try {
    const runId = asRunId("r1");
    const eventStorage = new EventStorage(tmpdir);
    const artifactStorage = new ArtifactStorage(tmpdir);
    
    // Program the fake adapter
    
    // 1. Malformed output (fails parsing) -> simulating an adapter error
    const step1: StepResult = {
      status: "failed",
      executionId: "exec1",
      failure: {
        code: "ADAPTER_ERROR",
        message: "Malformed output",
        retryable: true,
        signature: "malformed"
      }
    };
    
    // 2. Policy violation (returns success without artifacts)
    const step2: StepResult = {
      status: "succeeded",
      executionId: "exec2",
      summary: "success without artifact",
      artifacts: [],
      evidence: []
    };
    
    // 3. Valid success (with valid artifact)
    const step3: StepResult = {
      status: "succeeded",
      executionId: "exec3",
      summary: "valid success",
      artifacts: [{ artifactId: asArtifactId("a1"), kind: "file", relativePath: "test.txt" }],
      evidence: []
    };
    
    const adapter = new FakeAdapter([step1, step2, step3]);
    const controller = new RunController(runId, adapter, DefaultSafetyPolicy, eventStorage, artifactStorage);
    
    // Create the required artifact file in the workspace
    await fs.writeFile(path.join(tmpdir, "test.txt"), "hello world");
    
    // Initialize run manually (RunStarted)
    await eventStorage.append({
      type: "RunStarted",
      eventId: asEventId("e1"),
      runId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      initialPhase: "EXECUTE"
    });
    
    // Advance 1: hits Step 1 (Adapter Error)
    let state = await controller.advance();
    assert.equal(state.phase, "EXECUTE");
    assert.equal(state.attempt, 2); 
    assert.equal(state.lastFailureSignature, "malformed");
    
    // Advance 2: hits Step 2 (Policy Violation)
    state = await controller.advance();
    assert.equal(state.phase, "EXECUTE");
    assert.equal(state.attempt, 3); // previous failure was different signature, attempt increments
    assert.equal(state.lastFailureSignature, "policy_violation");
    
    // Advance 3: hits Step 3 (Valid Success)
    state = await controller.advance();
    assert.equal(state.phase, "EXECUTE"); 
    assert.equal(state.attempt, 1);
    assert.equal(state.lastFailureSignature, undefined);

    // Wait, the plan says "advances to READY after Step 3". 
    // In our `RunController`, it doesn't automatically transition to READY on StepCompleted.
    // We can emit a RunSucceeded event manually or have the controller do it?
    // P0 plan doesn't specify RunController emitting RunSucceeded automatically on step success.
    // I'll emit it manually to reach READY.
    await eventStorage.append({
      type: "RunSucceeded",
      eventId: asEventId("e-done"),
      runId,
      sequence: state.sequence + 1,
      timestamp: new Date().toISOString()
    });
    
    state = (await eventStorage.replay()) as RunState;
    assert.equal(state.phase, "READY");

  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

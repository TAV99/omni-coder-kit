import test from "node:test";
import assert from "node:assert/strict";
import { faultScenarios } from "../../src/v4/testing/fault-scenarios";
import { FileEventStore, replayRun } from "../../src/v4/storage/event-store";
import { REQUIRED_CHAOS_SCENARIOS } from "../../src/v4/testing/chaos-manifest";

test("fault-injection: required chaos manifest has the exact Milestone 6 scenario IDs", () => {
  assert.deepEqual(
    REQUIRED_CHAOS_SCENARIOS.map((scenario) => scenario.id),
    [
      "network-disconnect",
      "cli-nonzero-structured",
      "cli-nonzero-unstructured",
      "cli-output-drift",
      "event-persistence-failure",
      "artifact-persistence-failure",
      "evidence-persistence-failure",
      "repeated-timeout",
      "artifact-tamper",
      "protected-workspace-side-effect",
      "protected-external-side-effect",
    ]
  );
  assert.equal(new Set(REQUIRED_CHAOS_SCENARIOS.map((scenario) => scenario.id)).size, 11);
  for (const scenario of REQUIRED_CHAOS_SCENARIOS) {
    assert.match(scenario.testFile, /^test\/v4\/.+\.test\.ts$/);
    assert.ok(scenario.testName.length > 0);
    assert.notEqual(scenario.expectedOutcome, "success");
    if (scenario.faultScenario) {
      assert.ok(
        scenario.faultScenario in faultScenarios,
        `${scenario.id} references missing fault scenario '${scenario.faultScenario}'`
      );
    }
  }
});

test("fault-injection: includes a repeated timeout scenario", () => {
  assert.ok(
    "repeatedTimeout" in faultScenarios,
    "Milestone 6 requires the same timeout to repeat before the run blocks"
  );
});

test("fault-injection: includes a filesystem unavailable scenario", () => {
  assert.ok(
    "filesystemUnavailable" in faultScenarios,
    "Milestone 6 requires persistence failure to produce zero false success"
  );
});

test("fault-injection: includes an explicit network disconnect scenario", () => {
  assert.ok(
    "networkDisconnect" in faultScenarios,
    "A generic provider throw is not exact evidence for a network disconnect"
  );
});

test("fault-injection: table-driven suite over all fault scenarios", async () => {
  for (const [scenarioName, builder] of Object.entries(faultScenarios)) {
    const fixture = await builder();
    try {
      if (fixture.name === "truncatedEventLog") {
        await assert.rejects(
          fixture.run(),
          (err: any) => err?.name === "CorruptEventLogError",
          "A truncated durable tail must fail closed with a typed corruption error"
        );
        continue;
      }

      await fixture.run();

      const store = new FileEventStore({ projectDir: fixture.projectDir });
      let events: readonly any[] = [];
      try {
        events = await store.read(fixture.runId);
      } catch (err: any) {
        throw err;
      }

      if (events.length > 0) {
        const state = replayRun(events);
        assert.equal(
          state.phase,
          fixture.expectedTerminalPhase,
          `Scenario ${scenarioName} failed: expected phase ${fixture.expectedTerminalPhase}, got ${state.phase}`
        );
        assert.notEqual(state.phase, "READY", `Scenario ${scenarioName} should not reach READY`);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

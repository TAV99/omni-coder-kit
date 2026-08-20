import test from "node:test";
import assert from "node:assert/strict";
import { faultScenarios } from "../../src/v4/testing/fault-scenarios";
import { FileEventStore, replayRun } from "../../src/v4/storage/event-store";

test("fault-injection: table-driven suite over all fault scenarios", async () => {
  for (const [scenarioName, builder] of Object.entries(faultScenarios)) {
    const fixture = await builder();
    try {
      await fixture.run();

      const store = new FileEventStore({ projectDir: fixture.projectDir });
      let events: readonly any[] = [];
      try {
        events = await store.read(fixture.runId);
      } catch (err: any) {
        if (fixture.name === "truncatedEventLog") {
          // Expected corrupt log
          continue;
        }
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

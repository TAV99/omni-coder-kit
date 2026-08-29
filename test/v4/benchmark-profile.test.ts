import test from "node:test";
import assert from "node:assert/strict";
import {
  BenchmarkProfileInputSchema,
  profileBenchmarkRuns,
  renderBenchmarkProfileMarkdown,
} from "../../src/v4/benchmark/profile";

test("benchmark_profile: profiles repeated runs without converting missing metrics to zero", () => {
  const profile = profileBenchmarkRuns({
    schemaVersion: 1,
    runs: [
      {
        runId: "run-a",
        sourceRevision: "abc",
        cleanSource: true,
        wallClockMs: 100,
        inputTokens: 1000,
        outputTokens: 200,
        contextBytes: 4096,
        artifactBytes: 512,
      },
      {
        runId: "run-b",
        sourceRevision: "abc",
        cleanSource: true,
        wallClockMs: 300,
        inputTokens: 3000,
        outputTokens: 400,
      },
    ],
  });

  assert.equal(profile.runCount, 2);
  assert.equal(profile.cleanRunCount, 2);
  assert.equal(profile.allRunsClean, true);
  assert.equal(profile.wallClockMs.mean, 200);
  assert.equal(profile.inputTokens.p50, 1000);
  assert.equal(profile.contextBytes.availableCount, 1);
  assert.equal(profile.contextBytes.missingCount, 1);
  assert.equal(profile.contextBytes.mean, 4096);
  assert.equal(profile.artifactBytes.missingCount, 1);
});

test("benchmark_profile: empty inputs remain explicit and strict", () => {
  const profile = profileBenchmarkRuns({ schemaVersion: 1, runs: [] });
  assert.equal(profile.runCount, 0);
  assert.equal(profile.allRunsClean, false);
  assert.equal(profile.wallClockMs.mean, null);
  assert.equal(profile.contextBytes.p95, null);

  assert.equal(
    BenchmarkProfileInputSchema.safeParse({ schemaVersion: 1, runs: [], extra: true }).success,
    false
  );
});

test("benchmark_profile: renderer identifies unavailable context metrics", () => {
  const markdown = renderBenchmarkProfileMarkdown(
    profileBenchmarkRuns({
      schemaVersion: 1,
      runs: [
        {
          runId: "run-a",
          sourceRevision: "abc",
          cleanSource: false,
          wallClockMs: 100,
        },
      ],
    })
  );
  assert.match(markdown, /Clean source runs \| 0\/1/);
  assert.match(markdown, /Context bytes \| unavailable/);
});

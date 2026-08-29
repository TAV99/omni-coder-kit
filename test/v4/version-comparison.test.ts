import test from "node:test";
import assert from "node:assert/strict";
import {
  VersionComparisonInputSchema,
  compareBenchmarkVersions,
  renderVersionComparisonMarkdown,
} from "../../src/v4/benchmark/version-comparison";

test("version_comparison: correctness regression fails before performance improvement", () => {
  const comparison = compareBenchmarkVersions({
    schemaVersion: 1,
    baseline: {
      label: "v3",
      corpusId: "a".repeat(64),
      reliableCompletionRate: 0.95,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 1000,
      p95ContextBytes: 8000,
    },
    candidate: {
      label: "v4",
      corpusId: "a".repeat(64),
      reliableCompletionRate: 0.9,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 500,
      p95ContextBytes: 6000,
    },
  });

  assert.equal(comparison.correctnessRegression, true);
  assert.equal(comparison.performanceImproved, true);
  assert.equal(comparison.gateStatus, "failed");
  assert.equal(comparison.deltas.reliableCompletionRate, -0.05);
  assert.equal(comparison.deltas.medianWallClockMs, -500);
});

test("version_comparison: unavailable baseline metrics produce an inconclusive gate", () => {
  const comparison = compareBenchmarkVersions({
    schemaVersion: 1,
    baseline: {
      label: "v3",
      corpusId: "b".repeat(64),
      reliableCompletionRate: null,
      falseSuccessRate: null,
      resumeCorrectnessRate: null,
      medianWallClockMs: null,
      p95ContextBytes: null,
    },
    candidate: {
      label: "v4",
      corpusId: "b".repeat(64),
      reliableCompletionRate: 0.95,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 500,
      p95ContextBytes: 6000,
    },
  });

  assert.equal(comparison.gateStatus, "inconclusive");
  assert.deepEqual(comparison.missingComparisons, [
    "reliableCompletionRate",
    "falseSuccessRate",
    "resumeCorrectnessRate",
    "medianWallClockMs",
    "p95ContextBytes",
  ]);
});

test("version_comparison: strict contract rejects equal labels and unknown fields", () => {
  const snapshot = {
    label: "same",
    corpusId: "c".repeat(64),
    reliableCompletionRate: 1,
    falseSuccessRate: 0,
    resumeCorrectnessRate: 1,
    medianWallClockMs: 1,
    p95ContextBytes: 1,
  };
  assert.equal(
    VersionComparisonInputSchema.safeParse({
      schemaVersion: 1,
      baseline: snapshot,
      candidate: snapshot,
    }).success,
    false
  );
  assert.equal(
    VersionComparisonInputSchema.safeParse({
      schemaVersion: 1,
      baseline: { ...snapshot, label: "v3" },
      candidate: { ...snapshot, label: "v4" },
      extra: true,
    }).success,
    false
  );
});

test("version_comparison: renderer states correctness-first outcome", () => {
  const comparison = compareBenchmarkVersions({
    schemaVersion: 1,
    baseline: {
      label: "v3",
      corpusId: "d".repeat(64),
      reliableCompletionRate: 0.9,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 1000,
      p95ContextBytes: 8000,
    },
    candidate: {
      label: "v4",
      corpusId: "d".repeat(64),
      reliableCompletionRate: 0.95,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 900,
      p95ContextBytes: 7000,
    },
  });
  const markdown = renderVersionComparisonMarkdown(comparison);
  assert.match(markdown, /Gate status \| PASSED/);
  assert.match(markdown, /v3 → v4/);
});

test("version_comparison: corpus identity is required, checksum-shaped, and identical", () => {
  const metrics = {
    reliableCompletionRate: 1,
    falseSuccessRate: 0,
    resumeCorrectnessRate: 1,
    medianWallClockMs: 100,
    p95ContextBytes: 200,
  };
  assert.equal(
    VersionComparisonInputSchema.safeParse({
      schemaVersion: 1,
      baseline: { label: "v3", ...metrics },
      candidate: { label: "v4", ...metrics },
    }).success,
    false
  );
  assert.equal(
    VersionComparisonInputSchema.safeParse({
      schemaVersion: 1,
      baseline: { label: "v3", corpusId: "placeholder", ...metrics },
      candidate: { label: "v4", corpusId: "placeholder", ...metrics },
    }).success,
    false
  );
  assert.equal(
    VersionComparisonInputSchema.safeParse({
      schemaVersion: 1,
      baseline: { label: "v3", corpusId: "e".repeat(64), ...metrics },
      candidate: { label: "v4", corpusId: "f".repeat(64), ...metrics },
    }).success,
    false
  );
});

test("version_comparison: rejects different task corpus identities", () => {
  assert.throws(() => compareBenchmarkVersions({
    schemaVersion: 1,
    baseline: {
      label: "v3",
      corpusId: "corpus-a",
      reliableCompletionRate: 0.8,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 100,
      p95ContextBytes: null,
    },
    candidate: {
      label: "v4",
      corpusId: "corpus-b",
      reliableCompletionRate: 1,
      falseSuccessRate: 0,
      resumeCorrectnessRate: 1,
      medianWallClockMs: 90,
      p95ContextBytes: 1000,
    },
  }), /corpus/i);
});

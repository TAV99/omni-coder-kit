import test from "node:test";
import assert from "node:assert/strict";
import {
  BenchmarkAggregationInputSchema,
  aggregateBenchmarkReliability,
  renderBenchmarkAggregateMarkdown,
} from "../../src/v4/benchmark/aggregate";

test("aggregate_reliability: counts only applicable tasks and enforces the threshold", () => {
  const aggregate = aggregateBenchmarkReliability({
    schemaVersion: 1,
    threshold: 0.9,
    cases: [
      {
        id: "working-pass",
        applicability: "applicable",
        workingResult: true,
        mandatoryGatesPassed: true,
        acceptanceSatisfied: true,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: false,
      },
      {
        id: "missing-evidence",
        applicability: "applicable",
        workingResult: true,
        mandatoryGatesPassed: true,
        acceptanceSatisfied: true,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: false,
        },
        falseSuccess: false,
      },
      {
        id: "fault-injection",
        applicability: "not-applicable",
        workingResult: false,
        mandatoryGatesPassed: false,
        acceptanceSatisfied: false,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: false,
      },
    ],
  });

  assert.equal(aggregate.applicableTaskCount, 2);
  assert.equal(aggregate.reliableCompletionCount, 1);
  assert.equal(aggregate.reliableCompletionRate, 0.5);
  assert.equal(aggregate.thresholdStatus, "failed");
  assert.deepEqual(aggregate.unreliableCaseIds, ["missing-evidence"]);
});

test("aggregate_reliability: zero applicable tasks is inconclusive, never 100 percent", () => {
  const aggregate = aggregateBenchmarkReliability({
    schemaVersion: 1,
    threshold: 0.9,
    cases: [
      {
        id: "fault-only",
        applicability: "not-applicable",
        workingResult: false,
        mandatoryGatesPassed: false,
        acceptanceSatisfied: false,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: false,
      },
    ],
  });

  assert.equal(aggregate.reliableCompletionRate, null);
  assert.equal(aggregate.thresholdStatus, "inconclusive");
});

test("aggregate_reliability: strict input rejects unknown fields and duplicate IDs", () => {
  assert.equal(
    BenchmarkAggregationInputSchema.safeParse({
      schemaVersion: 1,
      threshold: 0.9,
      cases: [],
      unexpected: true,
    }).success,
    false
  );

  const duplicate = {
    id: "duplicate",
    applicability: "applicable" as const,
    workingResult: true,
    mandatoryGatesPassed: true,
    acceptanceSatisfied: true,
    evidence: {
      runIdentityRecorded: true,
      expectedOutcomeRecorded: true,
      mandatoryGateEvidenceComplete: true,
      acceptanceEvidenceComplete: true,
    },
    falseSuccess: false,
  };
  assert.throws(
    () =>
      aggregateBenchmarkReliability({
        schemaVersion: 1,
        threshold: 0.9,
        cases: [duplicate, duplicate],
      }),
    /duplicate/i
  );
});

test("aggregate_reliability: renderer exposes the denominator and SLO status", () => {
  const aggregate = aggregateBenchmarkReliability({
    schemaVersion: 1,
    threshold: 0.9,
    cases: [],
  });
  const markdown = renderBenchmarkAggregateMarkdown(aggregate);
  assert.match(markdown, /Applicable tasks \| 0/);
  assert.match(markdown, /Threshold status \| INCONCLUSIVE/);
});

test("aggregate_reliability: any false success fails the SLO, including negative cases", () => {
  const aggregate = aggregateBenchmarkReliability({
    schemaVersion: 1,
    threshold: 0.9,
    cases: [
      {
        id: "working-pass",
        applicability: "applicable",
        workingResult: true,
        mandatoryGatesPassed: true,
        acceptanceSatisfied: true,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: false,
      },
      {
        id: "negative-false-green",
        applicability: "not-applicable",
        workingResult: false,
        mandatoryGatesPassed: false,
        acceptanceSatisfied: false,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: true,
      },
    ],
  });

  assert.equal(aggregate.reliableCompletionRate, 1);
  assert.equal(aggregate.falseSuccessCount, 1);
  assert.equal(aggregate.thresholdStatus, "failed");
  assert.deepEqual(aggregate.falseSuccessCaseIds, ["negative-false-green"]);
});

test("aggregate_reliability: evidence completeness is derived only from explicit evidence facts", () => {
  const aggregate = aggregateBenchmarkReliability({
    schemaVersion: 1,
    threshold: 0.9,
    cases: [
      {
        id: "looks-green-but-untraced",
        applicability: "applicable",
        workingResult: true,
        mandatoryGatesPassed: true,
        acceptanceSatisfied: true,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: false,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: false,
      },
    ],
  });

  assert.equal(aggregate.evidenceCompleteCount, 0);
  assert.equal(aggregate.reliableCompletionCount, 0);
  assert.equal(aggregate.thresholdStatus, "failed");
});

test("aggregate_reliability: any false success fails the SLO even at 100 percent completion", () => {
  const aggregate = aggregateBenchmarkReliability({
    schemaVersion: 1,
    threshold: 0.5,
    cases: [
      {
        id: "valid",
        applicability: "applicable",
        workingResult: true,
        mandatoryGatesPassed: true,
        acceptanceSatisfied: true,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: false,
      },
      {
        id: "false-green",
        applicability: "applicable",
        workingResult: true,
        mandatoryGatesPassed: true,
        acceptanceSatisfied: true,
        evidence: {
          runIdentityRecorded: true,
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete: true,
          acceptanceEvidenceComplete: true,
        },
        falseSuccess: true,
      },
    ],
  });
  assert.equal(aggregate.falseSuccessCount, 1);
  assert.equal(aggregate.thresholdStatus, "failed");
});

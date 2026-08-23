import test from "node:test";
import assert from "node:assert/strict";
import { BudgetPolicy } from "../../src/v4/metrics/budget-policy";
import type { RunMetrics } from "../../src/v4/metrics/contracts";
import {
  asRequirementId,
  type QualityDecision,
} from "../../src/v4/contracts/quality";
import { asRunId } from "../../src/v4/contracts/ids";

function makeMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    schemaVersion: 1,
    runId: asRunId("run-b-1"),
    actualStatus: "succeeded",
    reportedStatus: "succeeded",
    falseSuccess: false,
    falseFailure: false,
    gateCounts: { passed: 2, failed: 0, skipped: 0, inconclusive: 0 },
    retryCount: 0,
    repairCount: 0,
    resumeCount: 0,
    userInterventionCount: 0,
    wallClockMs: 5000,
    summedGateDurationMs: 8000,
    gateQueueMs: 10,
    peakParallelism: 2,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      costUsd: 0.05,
    },
    missingMetrics: [],
    ...overrides,
  };
}

test("default_report_only", () => {
  // R65: Efficiency budgets default to report-only
  const metrics = makeMetrics({ wallClockMs: 10000 });
  const decision: QualityDecision = { kind: "advance", to: "ACCEPT" };

  // 1. Without mode specified
  const evalRes1 = BudgetPolicy.evaluate(
    { wallClockMs: 5000 },
    metrics,
    decision
  );
  assert.equal(evalRes1.mode, "report");
  assert.equal(evalRes1.outcome, "failed");
  assert.equal(evalRes1.breaches.length, 1);
  assert.equal(evalRes1.adjustedDecision, undefined);

  // 2. Without config at all
  const evalRes2 = BudgetPolicy.evaluate(
    undefined,
    metrics,
    decision
  );
  assert.equal(evalRes2.mode, "report");
  assert.equal(evalRes2.outcome, "passed");
  assert.equal(evalRes2.breaches.length, 0);
  assert.equal(evalRes2.adjustedDecision, undefined);
});

test("report_only_does_not_block", () => {
  // R66: A report-only budget breach cannot change the acceptance verdict
  const metrics = makeMetrics({
    wallClockMs: 500000, // 100x over limit
    usage: {
      inputTokens: 500000,
      outputTokens: 200000,
      totalTokens: 700000,
      costUsd: 50.0,
    },
  });
  const advanceDecision: QualityDecision = { kind: "advance", to: "ACCEPT" };

  const evalRes = BudgetPolicy.evaluate(
    {
      mode: "report",
      wallClockMs: 5000,
      totalTokens: 10000,
      costUsd: 1.0,
    },
    metrics,
    advanceDecision
  );

  assert.equal(evalRes.mode, "report");
  assert.equal(evalRes.outcome, "failed");
  assert.equal(evalRes.breaches.length, 3);
  assert.equal(evalRes.passed, false);
  // Crucial: Acceptance verdict MUST NOT be changed in report mode
  assert.equal(evalRes.adjustedDecision, undefined);
});

test("mandatory_budget_blocks", () => {
  // R67: A mandatory budget breach fails the budget gate with BUDGET_EXCEEDED
  const metrics = makeMetrics({ wallClockMs: 10000 });
  const advanceDecision: QualityDecision = { kind: "advance", to: "ACCEPT" };

  const evalRes = BudgetPolicy.evaluate(
    { mode: "mandatory", wallClockMs: 5000 },
    metrics,
    advanceDecision
  );

  assert.equal(evalRes.mode, "mandatory");
  assert.equal(evalRes.outcome, "failed");
  assert.equal(evalRes.code, "BUDGET_EXCEEDED");
  assert.equal(evalRes.passed, false);
  assert.ok(evalRes.adjustedDecision);
  assert.equal(evalRes.adjustedDecision?.kind, "block");
  if (evalRes.adjustedDecision?.kind === "block") {
    assert.match(evalRes.adjustedDecision.reason, /BUDGET_EXCEEDED/);
  }

  // If already repairing or blocked due to correctness, correctness decision is not overwritten!
  const repairDecision: QualityDecision = {
    kind: "repair",
    to: "FIX",
    requirementIds: [asRequirementId("R1")],
  };
  const evalRepair = BudgetPolicy.evaluate(
    { mode: "mandatory", wallClockMs: 5000 },
    metrics,
    repairDecision
  );
  assert.equal(evalRepair.adjustedDecision?.kind, "repair");
  if (evalRepair.adjustedDecision?.kind === "repair") {
    assert.deepEqual(evalRepair.adjustedDecision.requirementIds, [asRequirementId("R1")]);
  }
});

test("mandatory_missing_metric_inconclusive", () => {
  // R68: A missing metric required by a mandatory budget is inconclusive
  // Case A: usage object is undefined
  const metricsNoUsage = makeMetrics({ usage: undefined, missingMetrics: ["usage.costUsd"] });
  const advanceDecision: QualityDecision = { kind: "advance", to: "ACCEPT" };

  const evalRes1 = BudgetPolicy.evaluate(
    { mode: "mandatory", costUsd: 1.0 },
    metricsNoUsage,
    advanceDecision
  );

  assert.equal(evalRes1.mode, "mandatory");
  assert.equal(evalRes1.outcome, "inconclusive");
  assert.equal(evalRes1.code, "BUDGET_METRIC_MISSING");
  assert.equal(evalRes1.passed, false);
  assert.ok(evalRes1.adjustedDecision);
  assert.equal(evalRes1.adjustedDecision?.kind, "block");
  if (evalRes1.adjustedDecision?.kind === "block") {
    assert.match(evalRes1.adjustedDecision.reason, /BUDGET_METRIC_MISSING/);
  }

  // Case B: numeric value is 0 but missingMetrics explicitly records it as missing
  const metricsZeroMissing = makeMetrics({
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    missingMetrics: ["usage.costUsd"],
  });

  const evalRes2 = BudgetPolicy.evaluate(
    { mode: "mandatory", costUsd: 1.0 },
    metricsZeroMissing,
    advanceDecision
  );

  assert.equal(evalRes2.outcome, "inconclusive");
  assert.equal(evalRes2.code, "BUDGET_METRIC_MISSING");
  assert.equal(evalRes2.passed, false);
});

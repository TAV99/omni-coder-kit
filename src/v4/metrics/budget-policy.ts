import type { BudgetsConfig } from "../quality/config";
import type { RunMetrics } from "./contracts";
import type { QualityDecision } from "../contracts/quality";

export type BudgetOutcome = "passed" | "failed" | "inconclusive";

export interface BudgetBreach {
  readonly metric: string;
  readonly limit: number;
  readonly actual?: number | undefined;
  readonly status: "exceeded" | "missing_metric";
  readonly message: string;
}

export interface BudgetEvaluationResult {
  readonly mode: "report" | "mandatory";
  readonly outcome: BudgetOutcome;
  readonly code?: "BUDGET_EXCEEDED" | "BUDGET_METRIC_MISSING" | undefined;
  readonly breaches: readonly BudgetBreach[];
  readonly passed: boolean;
  readonly adjustedDecision?: QualityDecision | undefined;
}

export class BudgetPolicy {
  static evaluate(
    config: Partial<BudgetsConfig> | undefined,
    metrics: RunMetrics,
    currentDecision: QualityDecision
  ): BudgetEvaluationResult {
    if (!config) {
      return {
        mode: "report",
        outcome: "passed",
        breaches: [],
        passed: true,
      };
    }

    const mode = config.mode ?? "report";
    const breaches: BudgetBreach[] = [];

    // Helper to evaluate a specific limit
    const checkLimit = (
      metricName: string,
      missingKey: string,
      limit: number | undefined,
      actual: number | undefined
    ) => {
      if (limit === undefined) return;

      const isMissing =
        actual === undefined ||
        metrics.missingMetrics.includes(metricName) ||
        metrics.missingMetrics.includes(missingKey);

      if (isMissing) {
        breaches.push({
          metric: metricName,
          limit,
          actual: undefined,
          status: "missing_metric",
          message: `Mandatory budget limit for '${metricName}' (${limit}) could not be evaluated: metric is missing`,
        });
        return;
      }

      if (actual > limit) {
        breaches.push({
          metric: metricName,
          limit,
          actual,
          status: "exceeded",
          message: `Budget limit for '${metricName}' exceeded: actual ${actual} > limit ${limit}`,
        });
      }
    };

    checkLimit("wallClockMs", "wallClockMs", config.wallClockMs, metrics.wallClockMs);
    checkLimit("inputTokens", "usage.inputTokens", config.inputTokens, metrics.usage?.inputTokens);
    checkLimit("outputTokens", "usage.outputTokens", config.outputTokens, metrics.usage?.outputTokens);
    checkLimit("totalTokens", "usage.totalTokens", config.totalTokens, metrics.usage?.totalTokens);
    checkLimit("costUsd", "usage.costUsd", config.costUsd, metrics.usage?.costUsd);

    const hasMissing = breaches.some((b) => b.status === "missing_metric");
    let outcome: BudgetOutcome = "passed";
    let code: "BUDGET_EXCEEDED" | "BUDGET_METRIC_MISSING" | undefined;

    if (breaches.length > 0) {
      if (hasMissing) {
        outcome = "inconclusive";
        code = "BUDGET_METRIC_MISSING";
      } else {
        outcome = "failed";
        code = "BUDGET_EXCEEDED";
      }
    }

    const passed = outcome === "passed";

    // In report mode: decision is never modified!
    if (mode === "report" || passed) {
      return {
        mode,
        outcome,
        code,
        breaches,
        passed,
      };
    }

    // In mandatory mode with breaches:
    // If currentDecision is already "repair" or "block" due to correctness, preserve the original failure!
    if (currentDecision.kind === "block" || currentDecision.kind === "repair") {
      return {
        mode,
        outcome,
        code,
        breaches,
        passed: false,
        adjustedDecision: currentDecision,
      };
    }

    // If currentDecision was "advance", mandatory budget failure blocks the run
    const reason = breaches.map((b) => b.message).join("; ");
    const adjustedDecision: QualityDecision = {
      kind: "block",
      reason: `[${code}] ${reason}`,
      requiredAction: "Adjust budget limits or optimize execution",
    };

    return {
      mode,
      outcome,
      code,
      breaches,
      passed: false,
      adjustedDecision,
    };
  }
}

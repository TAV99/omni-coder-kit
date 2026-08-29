import { z } from "zod";

export const BenchmarkEvidenceFactsSchema = z
  .object({
    runIdentityRecorded: z.boolean(),
    expectedOutcomeRecorded: z.boolean(),
    mandatoryGateEvidenceComplete: z.boolean(),
    acceptanceEvidenceComplete: z.boolean(),
  })
  .strict();

export const BenchmarkTaskOutcomeSchema = z
  .object({
    id: z.string().min(1),
    applicability: z.enum(["applicable", "not-applicable"]),
    workingResult: z.boolean(),
    mandatoryGatesPassed: z.boolean(),
    acceptanceSatisfied: z.boolean(),
    evidence: BenchmarkEvidenceFactsSchema,
    falseSuccess: z.boolean(),
  })
  .strict();

export const BenchmarkAggregationInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    threshold: z.number().min(0).max(1),
    cases: z.array(BenchmarkTaskOutcomeSchema).readonly(),
  })
  .strict();

export const BenchmarkAggregateSchema = z
  .object({
    schemaVersion: z.literal(1),
    threshold: z.number().min(0).max(1),
    totalCaseCount: z.number().int().nonnegative(),
    applicableTaskCount: z.number().int().nonnegative(),
    reliableCompletionCount: z.number().int().nonnegative(),
    reliableCompletionRate: z.number().min(0).max(1).nullable(),
    falseSuccessCount: z.number().int().nonnegative(),
    falseSuccessCaseIds: z.array(z.string().min(1)).readonly(),
    evidenceCompleteCount: z.number().int().nonnegative(),
    thresholdStatus: z.enum(["passed", "failed", "inconclusive"]),
    unreliableCaseIds: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export type BenchmarkAggregationInput = z.infer<typeof BenchmarkAggregationInputSchema>;
export type BenchmarkAggregate = z.infer<typeof BenchmarkAggregateSchema>;

function isReliable(caseResult: z.infer<typeof BenchmarkTaskOutcomeSchema>): boolean {
  return (
    caseResult.workingResult &&
    caseResult.mandatoryGatesPassed &&
    caseResult.acceptanceSatisfied &&
    isEvidenceComplete(caseResult.evidence) &&
    !caseResult.falseSuccess
  );
}

function isEvidenceComplete(evidence: z.infer<typeof BenchmarkEvidenceFactsSchema>): boolean {
  return (
    evidence.runIdentityRecorded &&
    evidence.expectedOutcomeRecorded &&
    evidence.mandatoryGateEvidenceComplete &&
    evidence.acceptanceEvidenceComplete
  );
}

export function aggregateBenchmarkReliability(input: BenchmarkAggregationInput): BenchmarkAggregate {
  const parsed = BenchmarkAggregationInputSchema.parse(input);
  const ids = new Set<string>();
  for (const item of parsed.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate benchmark case ID '${item.id}'`);
    ids.add(item.id);
  }

  const applicable = parsed.cases.filter((item) => item.applicability === "applicable");
  const reliable = applicable.filter(isReliable);
  const reliableCompletionRate =
    applicable.length === 0 ? null : reliable.length / applicable.length;
  const falseSuccessCaseIds = parsed.cases.filter((item) => item.falseSuccess).map((item) => item.id);
  const falseSuccessCount = falseSuccessCaseIds.length;

  return BenchmarkAggregateSchema.parse({
    schemaVersion: 1,
    threshold: parsed.threshold,
    totalCaseCount: parsed.cases.length,
    applicableTaskCount: applicable.length,
    reliableCompletionCount: reliable.length,
    reliableCompletionRate,
    falseSuccessCount,
    falseSuccessCaseIds,
    evidenceCompleteCount: applicable.filter((item) => isEvidenceComplete(item.evidence)).length,
    thresholdStatus:
      falseSuccessCount > 0
        ? "failed"
        : reliableCompletionRate === null
        ? "inconclusive"
        : reliableCompletionRate >= parsed.threshold && falseSuccessCount === 0
          ? "passed"
          : "failed",
    unreliableCaseIds: applicable.filter((item) => !isReliable(item)).map((item) => item.id),
  });
}

export function renderBenchmarkAggregateMarkdown(aggregate: BenchmarkAggregate): string {
  const value = BenchmarkAggregateSchema.parse(aggregate);
  const rate =
    value.reliableCompletionRate === null
      ? "unavailable"
      : `${(value.reliableCompletionRate * 100).toFixed(2)}%`;
  return [
    "## Reliability SLO",
    "",
    "| Metric | Value |",
    "| :--- | :--- |",
    `| Applicable tasks | ${value.applicableTaskCount} |`,
    `| Reliable completions | ${value.reliableCompletionCount} |`,
    `| Reliable completion rate | ${rate} |`,
    `| Threshold | ${(value.threshold * 100).toFixed(2)}% |`,
    `| Threshold status | ${value.thresholdStatus.toUpperCase()} |`,
    `| False successes | ${value.falseSuccessCount} |`,
    `| Complete evidence trails | ${value.evidenceCompleteCount} |`,
  ].join("\n");
}

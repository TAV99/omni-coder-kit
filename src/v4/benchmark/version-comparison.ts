import { z } from "zod";

const NullableRateSchema = z.number().min(0).max(1).nullable();
const NullableMetricSchema = z.number().nonnegative().nullable();

export const VersionMetricsSnapshotSchema = z
  .object({
    label: z.string().min(1),
    corpusId: z.string().regex(/^[a-f0-9]{64}$/i, "corpusId must be a SHA-256 hex digest"),
    reliableCompletionRate: NullableRateSchema,
    falseSuccessRate: NullableRateSchema,
    resumeCorrectnessRate: NullableRateSchema,
    medianWallClockMs: NullableMetricSchema,
    p95ContextBytes: NullableMetricSchema,
  })
  .strict();

export const VersionComparisonInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseline: VersionMetricsSnapshotSchema,
    candidate: VersionMetricsSnapshotSchema,
  })
  .strict()
  .refine((value) => value.baseline.label !== value.candidate.label, {
    message: "Baseline and candidate labels must differ",
  })
  .refine((value) => value.baseline.corpusId === value.candidate.corpusId, {
    message: "Baseline and candidate task corpus identities must match",
  });

const DeltaSchema = z.number().nullable();

export const VersionComparisonSchema = z
  .object({
    schemaVersion: z.literal(1),
    baselineLabel: z.string().min(1),
    candidateLabel: z.string().min(1),
    corpusId: z.string().regex(/^[a-f0-9]{64}$/i, "corpusId must be a SHA-256 hex digest"),
    deltas: z
      .object({
        reliableCompletionRate: DeltaSchema,
        falseSuccessRate: DeltaSchema,
        resumeCorrectnessRate: DeltaSchema,
        medianWallClockMs: DeltaSchema,
        p95ContextBytes: DeltaSchema,
      })
      .strict(),
    correctnessRegression: z.boolean(),
    performanceImproved: z.boolean(),
    gateStatus: z.enum(["passed", "failed", "inconclusive"]),
    missingComparisons: z.array(z.string()).readonly(),
  })
  .strict();

export type VersionComparisonInput = z.infer<typeof VersionComparisonInputSchema>;
export type VersionComparison = z.infer<typeof VersionComparisonSchema>;

function delta(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  return Number((candidate - baseline).toFixed(6));
}

export function compareBenchmarkVersions(input: VersionComparisonInput): VersionComparison {
  const parsed = VersionComparisonInputSchema.parse(input);
  const deltas = {
    reliableCompletionRate: delta(
      parsed.baseline.reliableCompletionRate,
      parsed.candidate.reliableCompletionRate
    ),
    falseSuccessRate: delta(parsed.baseline.falseSuccessRate, parsed.candidate.falseSuccessRate),
    resumeCorrectnessRate: delta(
      parsed.baseline.resumeCorrectnessRate,
      parsed.candidate.resumeCorrectnessRate
    ),
    medianWallClockMs: delta(parsed.baseline.medianWallClockMs, parsed.candidate.medianWallClockMs),
    p95ContextBytes: delta(parsed.baseline.p95ContextBytes, parsed.candidate.p95ContextBytes),
  };
  const missingComparisons = Object.entries(deltas)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  const correctnessRegression =
    (deltas.reliableCompletionRate !== null && deltas.reliableCompletionRate < 0) ||
    (deltas.falseSuccessRate !== null && deltas.falseSuccessRate > 0) ||
    (deltas.resumeCorrectnessRate !== null && deltas.resumeCorrectnessRate < 0);
  const performanceDeltas = [deltas.medianWallClockMs, deltas.p95ContextBytes].filter(
    (value): value is number => value !== null
  );
  const performanceImproved =
    performanceDeltas.length > 0 &&
    performanceDeltas.every((value) => value <= 0) &&
    performanceDeltas.some((value) => value < 0);
  const correctnessMissing = [
    deltas.reliableCompletionRate,
    deltas.falseSuccessRate,
    deltas.resumeCorrectnessRate,
  ].some((value) => value === null);

  return VersionComparisonSchema.parse({
    schemaVersion: 1,
    baselineLabel: parsed.baseline.label,
    candidateLabel: parsed.candidate.label,
    corpusId: parsed.baseline.corpusId,
    deltas,
    correctnessRegression,
    performanceImproved,
    gateStatus: correctnessRegression ? "failed" : correctnessMissing ? "inconclusive" : "passed",
    missingComparisons,
  });
}

function formatDelta(value: number | null): string {
  return value === null ? "unavailable" : value > 0 ? `+${value}` : String(value);
}

export function renderVersionComparisonMarkdown(comparison: VersionComparison): string {
  const value = VersionComparisonSchema.parse(comparison);
  return [
    `## Version Comparison: ${value.baselineLabel} → ${value.candidateLabel}`,
    "",
    "| Metric | Candidate delta |",
    "| :--- | :--- |",
    `| Reliable completion rate | ${formatDelta(value.deltas.reliableCompletionRate)} |`,
    `| False-success rate | ${formatDelta(value.deltas.falseSuccessRate)} |`,
    `| Resume correctness rate | ${formatDelta(value.deltas.resumeCorrectnessRate)} |`,
    `| Median wall-clock ms | ${formatDelta(value.deltas.medianWallClockMs)} |`,
    `| P95 context bytes | ${formatDelta(value.deltas.p95ContextBytes)} |`,
    `| Correctness regression | ${value.correctnessRegression ? "YES" : "NO"} |`,
    `| Performance improved | ${value.performanceImproved ? "YES" : "NO"} |`,
    `| Gate status | ${value.gateStatus.toUpperCase()} |`,
  ].join("\n");
}

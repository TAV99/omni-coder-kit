import { z } from "zod";

const OptionalMetricSchema = z.number().nonnegative().optional();

export const BenchmarkProfileRunSchema = z
  .object({
    runId: z.string().min(1),
    sourceRevision: z.string().min(1),
    cleanSource: z.boolean(),
    wallClockMs: z.number().nonnegative(),
    inputTokens: OptionalMetricSchema,
    outputTokens: OptionalMetricSchema,
    contextBytes: OptionalMetricSchema,
    artifactBytes: OptionalMetricSchema,
  })
  .strict();

export const BenchmarkProfileInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    runs: z.array(BenchmarkProfileRunSchema).readonly(),
  })
  .strict();

export const NumericProfileSchema = z
  .object({
    availableCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    mean: z.number().nonnegative().nullable(),
    p50: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable(),
  })
  .strict();

export const BenchmarkProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    runCount: z.number().int().nonnegative(),
    cleanRunCount: z.number().int().nonnegative(),
    allRunsClean: z.boolean(),
    sourceRevisions: z.array(z.string().min(1)).readonly(),
    wallClockMs: NumericProfileSchema,
    inputTokens: NumericProfileSchema,
    outputTokens: NumericProfileSchema,
    contextBytes: NumericProfileSchema,
    artifactBytes: NumericProfileSchema,
  })
  .strict();

export type BenchmarkProfileInput = z.infer<typeof BenchmarkProfileInputSchema>;
export type BenchmarkProfile = z.infer<typeof BenchmarkProfileSchema>;
export type NumericProfile = z.infer<typeof NumericProfileSchema>;

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index]!;
}

function summarize(values: readonly (number | undefined)[], total: number): NumericProfile {
  const available = values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  if (available.length === 0) {
    return {
      availableCount: 0,
      missingCount: total,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
    };
  }
  return {
    availableCount: available.length,
    missingCount: total - available.length,
    min: available[0]!,
    max: available[available.length - 1]!,
    mean: rounded(available.reduce((sum, value) => sum + value, 0) / available.length),
    p50: percentile(available, 0.5),
    p95: percentile(available, 0.95),
  };
}

export function profileBenchmarkRuns(input: BenchmarkProfileInput): BenchmarkProfile {
  const parsed = BenchmarkProfileInputSchema.parse(input);
  const runIds = new Set<string>();
  for (const run of parsed.runs) {
    if (runIds.has(run.runId)) throw new Error(`Duplicate benchmark run ID '${run.runId}'`);
    runIds.add(run.runId);
  }
  const count = parsed.runs.length;
  return BenchmarkProfileSchema.parse({
    schemaVersion: 1,
    runCount: count,
    cleanRunCount: parsed.runs.filter((run) => run.cleanSource).length,
    allRunsClean: count > 0 && parsed.runs.every((run) => run.cleanSource),
    sourceRevisions: [...new Set(parsed.runs.map((run) => run.sourceRevision))].sort(),
    wallClockMs: summarize(parsed.runs.map((run) => run.wallClockMs), count),
    inputTokens: summarize(parsed.runs.map((run) => run.inputTokens), count),
    outputTokens: summarize(parsed.runs.map((run) => run.outputTokens), count),
    contextBytes: summarize(parsed.runs.map((run) => run.contextBytes), count),
    artifactBytes: summarize(parsed.runs.map((run) => run.artifactBytes), count),
  });
}

function formatMetric(metric: NumericProfile): string {
  return metric.mean === null
    ? "unavailable"
    : `mean ${metric.mean}; p50 ${metric.p50}; p95 ${metric.p95}; missing ${metric.missingCount}`;
}

export function renderBenchmarkProfileMarkdown(profile: BenchmarkProfile): string {
  const value = BenchmarkProfileSchema.parse(profile);
  return [
    "## Performance and Context Profile",
    "",
    "| Metric | Value |",
    "| :--- | :--- |",
    `| Runs | ${value.runCount} |`,
    `| Clean source runs | ${value.cleanRunCount}/${value.runCount} |`,
    `| Wall-clock ms | ${formatMetric(value.wallClockMs)} |`,
    `| Input tokens | ${formatMetric(value.inputTokens)} |`,
    `| Output tokens | ${formatMetric(value.outputTokens)} |`,
    `| Context bytes | ${formatMetric(value.contextBytes)} |`,
    `| Artifact bytes | ${formatMetric(value.artifactBytes)} |`,
  ].join("\n");
}

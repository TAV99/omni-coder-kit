import { z } from "zod";
import type { RunId } from "../contracts/ids";
import type { GateStatus } from "../contracts/quality";
import type { NormalizedUsage } from "../contracts/step-result";

export const RunStatusSchema = z.enum(["succeeded", "failed", "inconclusive"]);
export type RunMetricStatus = z.infer<typeof RunStatusSchema>;

export interface AdapterIdentity {
  readonly name: string;
  readonly model?: string | undefined;
  readonly cliVersion?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface RunMetrics {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly actualStatus: RunMetricStatus;
  readonly reportedStatus: RunMetricStatus;
  readonly falseSuccess: boolean;
  readonly falseFailure: boolean;
  readonly gateCounts: Readonly<Record<GateStatus, number>>;
  readonly retryCount: number;
  readonly repairCount: number;
  readonly resumeCount: number;
  readonly userInterventionCount: number;
  readonly wallClockMs: number;
  readonly summedGateDurationMs: number;
  readonly gateQueueMs: number;
  readonly peakParallelism: number;
  readonly measuredSpeedup?: number | undefined;
  readonly usage?: NormalizedUsage | undefined;
  readonly adapter?: AdapterIdentity | undefined;
  readonly missingMetrics: readonly string[];
}

export const RunMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    actualStatus: RunStatusSchema,
    reportedStatus: RunStatusSchema,
    falseSuccess: z.boolean(),
    falseFailure: z.boolean(),
    gateCounts: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        inconclusive: z.number().int().nonnegative(),
      })
      .strict(),
    retryCount: z.number().int().nonnegative(),
    repairCount: z.number().int().nonnegative(),
    resumeCount: z.number().int().nonnegative(),
    userInterventionCount: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    summedGateDurationMs: z.number().int().nonnegative(),
    gateQueueMs: z.number().int().nonnegative(),
    peakParallelism: z.number().int().nonnegative(),
    measuredSpeedup: z.number().nonnegative().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        cachedInputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    adapter: z
      .object({
        name: z.string().min(1),
        model: z.string().optional(),
        cliVersion: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .strict()
      .optional(),
    missingMetrics: z.array(z.string()).readonly(),
  })
  .strict();

import { z } from "zod";
import { ArtifactClaimSchema, type ArtifactClaim } from "./artifact";
import { EvidenceSchema, type Evidence } from "./evidence";

export interface NormalizedUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

export interface NativeExecutionMetadata {
  readonly sessionId?: string | undefined;
  readonly cliVersion?: string | undefined;
  readonly model?: string | undefined;
  readonly usage?: NormalizedUsage | undefined;
  readonly processEvidence?: NativeProcessEvidence | undefined;
}

export interface NativeProcessEvidence {
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly termination: "exited" | "signalled" | "timed-out" | "aborted" | "output-limit" | "spawn-error";
  readonly exitCode: number | null;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export type AgentStepOutcome =
  | {
      readonly status: "succeeded";
      readonly executionId: string;
      readonly summary: string;
      readonly artifacts: readonly ArtifactClaim[];
      readonly evidence: readonly Evidence[];
    }
  | {
      readonly status: "failed";
      readonly executionId: string;
      readonly failure: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly signature: string;
      };
    }
  | {
      readonly status: "blocked";
      readonly executionId: string;
      readonly reason: string;
      readonly requiredAction: string;
    }
  | {
      readonly status: "cancelled";
      readonly executionId: string;
      readonly reason: string;
    };

export type StepResult = AgentStepOutcome & {
  readonly native?: NativeExecutionMetadata | undefined;
};

export const NormalizedUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().finite().optional(),
  })
  .strict();

export const NativeExecutionMetadataSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    cliVersion: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    usage: NormalizedUsageSchema.optional(),
    processEvidence: z
      .object({
        command: z.array(z.string()).min(1).readonly(),
        timeoutMs: z.number().int().positive(),
        termination: z.enum([
          "exited",
          "signalled",
          "timed-out",
          "aborted",
          "output-limit",
          "spawn-error",
        ]),
        exitCode: z.number().int().nullable(),
        stdoutSummary: z.string(),
        stderrSummary: z.string(),
        stdoutSha256: z.string().regex(/^[0-9a-f]{64}$/),
        stderrSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

const SuccessOutcomeFields = {
  status: z.literal("succeeded"),
  executionId: z.string().min(1),
  summary: z.string(),
  artifacts: z.array(ArtifactClaimSchema).readonly(),
  evidence: z.array(EvidenceSchema).readonly(),
};

const FailureDetailsSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    signature: z.string().min(1),
  })
  .strict();

const FailedOutcomeFields = {
  status: z.literal("failed"),
  executionId: z.string().min(1),
  failure: FailureDetailsSchema,
};

const BlockedOutcomeFields = {
  status: z.literal("blocked"),
  executionId: z.string().min(1),
  reason: z.string().min(1),
  requiredAction: z.string().min(1),
};

const CancelledOutcomeFields = {
  status: z.literal("cancelled"),
  executionId: z.string().min(1),
  reason: z.string().min(1),
};

export const AgentStepOutcomeSchema = z.discriminatedUnion("status", [
  z.object(SuccessOutcomeFields).strict(),
  z.object(FailedOutcomeFields).strict(),
  z.object(BlockedOutcomeFields).strict(),
  z.object(CancelledOutcomeFields).strict(),
]);

export const StepResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...SuccessOutcomeFields,
      native: NativeExecutionMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...FailedOutcomeFields,
      native: NativeExecutionMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...BlockedOutcomeFields,
      native: NativeExecutionMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...CancelledOutcomeFields,
      native: NativeExecutionMetadataSchema.optional(),
    })
    .strict(),
]);

import { z } from "zod";
import { ArtifactClaimSchema, type ArtifactClaim } from "./artifact";
import { EvidenceSchema, type Evidence } from "./evidence";

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export interface NativeExecutionMetadata {
  readonly sessionId?: string;
  readonly usage?: NormalizedUsage;
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
  readonly native?: NativeExecutionMetadata;
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
    usage: NormalizedUsageSchema.optional(),
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

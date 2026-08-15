import { z } from "zod";
import { ArtifactClaimSchema } from "./artifact";
import { EvidenceSchema } from "./evidence";

export const StepResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    executionId: z.string(),
    summary: z.string(),
    artifacts: z.array(ArtifactClaimSchema),
    evidence: z.array(EvidenceSchema),
    nativeSessionId: z.string().optional(),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    executionId: z.string(),
    failure: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      signature: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    status: z.literal("blocked"),
    executionId: z.string(),
    reason: z.string(),
    requiredAction: z.string(),
  }).strict(),
  z.object({
    status: z.literal("cancelled"),
    executionId: z.string(),
    reason: z.string(),
  }).strict(),
]);

export type StepResult = z.infer<typeof StepResultSchema>;

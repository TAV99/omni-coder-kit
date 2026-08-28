import { z } from "zod";
import { asArtifactId, asStepId, type ArtifactId, type StepId } from "./ids";

export const EVIDENCE_KINDS = [
  "command",
  "artifact",
  "agent-judgement",
  "policy",
] as const;

export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export interface Evidence {
  readonly schemaVersion: 1;
  readonly kind: EvidenceKind;
  readonly producerStepId: StepId;
  readonly method: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly artifactIds: readonly ArtifactId[];
  readonly summary: string;
  readonly command?: readonly string[] | undefined;
  readonly exitCode?: number | undefined;
}

export const EvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: EvidenceKindSchema,
    producerStepId: z.string().min(1).transform(asStepId),
    method: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().nonnegative(),
    artifactIds: z.array(z.string().min(1).transform(asArtifactId)).readonly(),
    summary: z.string(),
    command: z.array(z.string()).readonly().optional(),
    exitCode: z.number().int().optional(),
  })
  .strict();

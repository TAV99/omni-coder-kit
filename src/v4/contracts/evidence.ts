import { z } from "zod";
import { asArtifactId, asStepId, type ArtifactId, type StepId } from "./ids";

export const EvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["command", "artifact", "agent-judgement", "policy"]),
  producerStepId: z.string().transform(asStepId),
  method: z.string(),
  startedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  artifactIds: z.array(z.string().transform(asArtifactId)),
  summary: z.string(),
  command: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
}).strict();

export type Evidence = z.infer<typeof EvidenceSchema>;

import { z } from "zod";
import { asArtifactId, asRunId, asStepId, type ArtifactId, type RunId, type StepId } from "./ids";

const relativePathRegex = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).*$/;

export const ArtifactClaimSchema = z.object({
  artifactId: z.string().transform(asArtifactId),
  kind: z.enum(["file", "report", "manifest"]),
  relativePath: z.string().regex(relativePathRegex, "Path must be relative and cannot contain '..' segments"),
}).strict();

export type ArtifactClaim = z.infer<typeof ArtifactClaimSchema>;

export const ArtifactRecordSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string().transform(asArtifactId),
  runId: z.string().transform(asRunId),
  producerStepId: z.string().transform(asStepId),
  kind: z.enum(["file", "report", "manifest"]),
  relativePath: z.string().regex(relativePathRegex, "Path must be relative and cannot contain '..' segments"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Must be a valid lowercase SHA-256 hash"),
  sizeBytes: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
}).strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

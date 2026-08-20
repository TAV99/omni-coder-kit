import { z } from "zod";
import { asArtifactId, asRunId, asStepId, type ArtifactId, type RunId, type StepId } from "./ids";

export function isSafeRelativePath(p: string): boolean {
  if (!p || typeof p !== "string" || p.trim().length === 0) return false;
  // Reject absolute paths on POSIX and Windows
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[/\\]/.test(p)) return false;
  // Reject path segments containing '..'
  const segments = p.split(/[/\\]/);
  if (segments.some((seg) => seg === "..")) return false;
  return true;
}

const RelativePathSchema = z
  .string()
  .min(1)
  .refine(isSafeRelativePath, {
    message: "Path must be a non-empty relative path without '..' segments or absolute root",
  });

export const ARTIFACT_KINDS = ["file", "report", "manifest"] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactClaimSchema = z
  .object({
    artifactId: z.string().min(1).transform(asArtifactId),
    kind: ArtifactKindSchema,
    relativePath: RelativePathSchema,
  })
  .strict();

export type ArtifactClaim = {
  readonly artifactId: ArtifactId;
  readonly kind: ArtifactKind;
  readonly relativePath: string;
};

export const ArtifactRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().min(1).transform(asArtifactId),
    runId: z.string().min(1).transform(asRunId),
    producerStepId: z.string().min(1).transform(asStepId),
    kind: ArtifactKindSchema,
    relativePath: RelativePathSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "Must be a 64-character lowercase hex SHA-256 hash"),
    sizeBytes: z.number().int().nonnegative(),
    recordedAt: z.string().datetime(),
  })
  .strict();

export type ArtifactRecord = {
  readonly schemaVersion: 1;
  readonly artifactId: ArtifactId;
  readonly runId: RunId;
  readonly producerStepId: StepId;
  readonly kind: ArtifactKind;
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly recordedAt: string;
};

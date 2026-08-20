import fs from "node:fs/promises";
import { z } from "zod";

export const HostSpecSchema = z
  .object({
    binary: z.string().min(1),
    verifiedVersion: z.string().min(1),
    versionArgs: z.array(z.string()).readonly(),
    helpArgs: z.array(z.string()).readonly(),
    requiredFlags: z.array(z.string()).readonly(),
    contractVerified: z.boolean(),
    liveSmokeVerified: z.boolean(),
    verifiedPlatforms: z.array(z.string()).readonly(),
  })
  .strict();

export type HostSpec = z.infer<typeof HostSpecSchema>;

export const CompatibilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    verifiedAt: z.string().min(1),
    hosts: z.record(z.enum(["codex", "claude", "antigravity"]), HostSpecSchema),
  })
  .strict();

export type CompatibilityManifest = z.infer<typeof CompatibilityManifestSchema>;

export async function loadCompatibilityManifest(
  manifestPath: string
): Promise<CompatibilityManifest> {
  const content = await fs.readFile(manifestPath, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Failed to parse compatibility manifest JSON: ${err.message}`);
  }
  return CompatibilityManifestSchema.parse(json);
}

import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  GateDefinitionSchema,
  type GateDefinition,
} from "../contracts/quality";
import { QualityError } from "./errors";

export const BudgetsConfigSchema = z
  .object({
    mode: z.enum(["report", "mandatory"]).default("report"),
    wallClockMs: z.number().nonnegative().optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export type BudgetsConfig = z.infer<typeof BudgetsConfigSchema>;

export const QualityConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementsPath: z.string().min(1).default(".omni/sdlc/requirements.md"),
    outputSummaryBytes: z.number().int().positive().default(16384),
    maxRepairAttemptsPerRequirement: z.number().int().min(0).max(2).default(2),
    maxParallelGates: z.number().int().min(1).max(8).default(2),
    budgets: BudgetsConfigSchema.optional(),
    gates: z.array(GateDefinitionSchema),
  })
  .strict();

export type QualityConfig = z.infer<typeof QualityConfigSchema>;

function isPathInside(targetPath: string, rootDir: string): boolean {
  const rel = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function loadQualityConfig(
  projectRoot: string,
  customConfigPath?: string
): Promise<QualityConfig> {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedConfigPath = path.resolve(
    resolvedRoot,
    customConfigPath ?? path.join(".omni", "v4", "quality.json")
  );

  if (!isPathInside(resolvedConfigPath, resolvedRoot) && resolvedConfigPath !== resolvedRoot) {
    throw new QualityError(
      "QUALITY_CONFIG_INVALID",
      `Quality config path escapes project root: ${resolvedConfigPath}`
    );
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(resolvedConfigPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      throw new QualityError(
        "QUALITY_CONFIG_MISSING",
        `Quality configuration file not found at '${resolvedConfigPath}'`
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new QualityError(
      "QUALITY_CONFIG_INVALID",
      `Failed to read quality config file: ${msg}`
    );
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QualityError(
      "QUALITY_CONFIG_INVALID",
      `Invalid JSON in quality configuration: ${msg}`
    );
  }

  const parseRes = QualityConfigSchema.safeParse(rawJson);
  if (!parseRes.success) {
    throw new QualityError(
      "QUALITY_CONFIG_INVALID",
      `Quality configuration schema violation: ${parseRes.error.message}`
    );
  }

  const config = parseRes.data;

  // Validate requirementsPath containment
  const resolvedReqPath = path.resolve(resolvedRoot, config.requirementsPath);
  if (!isPathInside(resolvedReqPath, resolvedRoot) && resolvedReqPath !== resolvedRoot) {
    throw new QualityError(
      "QUALITY_CONFIG_INVALID",
      `requirementsPath '${config.requirementsPath}' resolves outside project root`
    );
  }

  // Validate each gate's cwd containment and uniqueness of gate IDs
  const seenGateIds = new Set<string>();
  for (const gate of config.gates) {
    if (seenGateIds.has(gate.id)) {
      throw new QualityError(
        "QUALITY_CONFIG_INVALID",
        `Duplicate gate ID '${gate.id}' in quality configuration`
      );
    }
    seenGateIds.add(gate.id);

    const resolvedGateCwd = path.resolve(resolvedRoot, gate.cwd);
    if (!isPathInside(resolvedGateCwd, resolvedRoot) && resolvedGateCwd !== resolvedRoot) {
      throw new QualityError(
        "QUALITY_CONFIG_INVALID",
        `Gate '${gate.id}' cwd '${gate.cwd}' resolves outside project root`
      );
    }
  }

  return config;
}

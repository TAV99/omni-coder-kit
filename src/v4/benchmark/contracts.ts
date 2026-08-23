import { z } from "zod";

export const BenchmarkExpectationSchema = z
  .object({
    finalPhase: z.string().min(1),
    acceptanceStatus: z.enum(["accepted", "rejected", "inconclusive", "none"]),
    falseSuccess: z.boolean().optional(),
    falseFailure: z.boolean().optional(),
    minPassedGates: z.number().int().nonnegative().optional(),
    maxRepairs: z.number().int().nonnegative().optional(),
    minPeakParallelism: z.number().int().nonnegative().optional(),
    maxPeakParallelism: z.number().int().nonnegative().optional(),
    recoveryExpected: z.boolean().optional(),
    budgetBreached: z.boolean().optional(),
  })
  .strict();

export type BenchmarkExpectation = z.infer<typeof BenchmarkExpectationSchema>;

export const BenchmarkCaseSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/, "Case ID must be path-safe (alphanumeric, dash, underscore)"),
    enabled: z.boolean(),
    projectKind: z.enum(["omni", "javascript", "non-javascript", "unusual-tests", "fixture"]),
    fixturePath: z.string().min(1).optional(),
    repositoryPath: z.string().min(1).optional(),
    adapter: z.enum(["fake", "codex", "claude", "antigravity"]),
    liveModelCostOptIn: z.boolean().default(false),
    scenario: z.enum(["standard", "repair-progress", "repair-no-progress", "crash-resume"]).optional(),
    expected: BenchmarkExpectationSchema,
    tags: z.array(z.string()).readonly(),
    description: z.string().optional(),
    activationChecklist: z.array(z.string()).readonly().optional(),
    baselineNotes: z.string().optional(),
    gateMapping: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export const BenchmarkManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z.array(BenchmarkCaseSchema),
  })
  .strict();

export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

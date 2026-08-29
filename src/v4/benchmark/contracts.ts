import { z } from "zod";
import { GateDefinitionSchema } from "../contracts/quality";
import { CapabilitySchema } from "../contracts/run";

const RepoRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === "." ||
      (!value.includes("\\") &&
        !value.startsWith("/") &&
        !/^[A-Za-z]:/.test(value) &&
        !value.split("/").includes("..")),
    "Path must be repository-relative"
  );

const RepoRelativePrefixSchema = RepoRelativePathSchema.refine(
  (value) => value !== ".",
  "Path prefix must identify a bounded repository subdirectory"
);

const SetupProgramSchema = z.string().min(1).refine((value) => {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return true;
  return value !== "." && RepoRelativePathSchema.safeParse(value).success;
}, "Program must be a native executable name or safe repository-relative executable path");

export const BenchmarkSetupCommandSchema = z
  .object({
    program: SetupProgramSchema,
    args: z.array(z.string()).readonly(),
    cwd: RepoRelativePathSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export const BenchmarkRequirementSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    text: z.string().min(1),
  })
  .strict();

export const BenchmarkLiveTaskSchema = z
  .object({
    prompt: z.string().min(1),
    allowedPaths: z.array(RepoRelativePathSchema).min(1).readonly(),
    allowedPathPrefixes: z.array(RepoRelativePrefixSchema).readonly().optional(),
    requiredCapabilities: z.array(CapabilitySchema).min(1).readonly(),
    sideEffect: z.literal("workspace-write"),
    timeoutMs: z.number().int().positive(),
    outputSummaryBytes: z.number().int().positive().optional(),
    requiredDependencyPolicy: z.enum(["clean-install", "existing-lockfile"]).optional(),
    requiredToolchain: z.record(z.string(), z.string().min(1)).optional(),
    setupCommands: z.array(BenchmarkSetupCommandSchema).readonly(),
    requirements: z.array(BenchmarkRequirementSchema).min(1).readonly(),
    gates: z.array(GateDefinitionSchema).min(1).readonly(),
  })
  .strict();

export type BenchmarkLiveTask = z.infer<typeof BenchmarkLiveTaskSchema>;

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
    applicability: z.enum(["applicable", "not-applicable"]),
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
    liveTask: BenchmarkLiveTaskSchema.optional(),
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

import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import {
  type BenchmarkCase,
  type BenchmarkExpectation,
  type BenchmarkManifest,
} from "./contracts";
import { QualityError } from "../quality/errors";
import { loadBenchmarkManifest, isBenchmarkPathContained } from "./manifest";
import { FileEventStore } from "../storage/event-store";
import {
  EvidenceBundleStore,
  type EvidenceBundle,
} from "../quality/evidence-bundle-store";
import { GateRegistry } from "../quality/gate-registry";
import { GateRunner } from "../quality/gate-runner";
import { AcceptanceEngine } from "../quality/acceptance-engine";
import { RepairPolicy } from "../quality/repair-policy";
import { GateScheduler } from "../quality/gate-scheduler";
import { QualityCoordinator } from "../quality/quality-coordinator";
import { NodeProcessRunner } from "../process/node-process-runner";
import { MetricsCollector } from "../metrics/collector";
import { BudgetPolicy } from "../metrics/budget-policy";
import { loadQualityConfig } from "../quality/config";
import { loadRequirements } from "../quality/requirements";
import { recoverRun } from "../core/recovery";
import { createDefaultPolicy } from "../policy/default-policy";
import { asEventId, asRunId, asStepId } from "../contracts/ids";
import {
  asGateId,
  asQualityCycleId,
  asRequirementId,
  truncateUtf8Bytes,
  type GateDefinition,
} from "../contracts/quality";
import type { RunMetrics } from "../metrics/contracts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../process/types";
import type { RunPhase } from "../contracts/run";
import type { RunEvent } from "../contracts/event";
import { FakeAdapter } from "../testing/fake-adapter";
import type { AgentAdapter } from "../contracts/adapter";
import { StepResultSchema } from "../contracts/step-result";
import type { NativeExecutionMetadata } from "../contracts/step-result";
import { computeSemanticHash } from "./report";
import { aggregateBenchmarkReliability, type BenchmarkAggregate } from "./aggregate";
import type { BenchmarkAggregationInput } from "./aggregate";
import {
  enforceExternalBindingContract,
  loadExternalBindings,
  requireExternalCaseBinding,
  type ExternalCaseBinding,
} from "./external-binding";
import {
  captureWorkspaceSnapshot,
  compareWorkspaceSnapshots,
  stagePinnedTrackedTree,
  WorkspaceDiffViolation,
  type ExternalSourceMetadata,
  type WorkspaceDiffEvidence,
  type WorkspaceSnapshot,
} from "./external-workspace";

export interface BenchmarkCaseResult {
  readonly id: string;
  readonly enabled: boolean;
  readonly status: "passed" | "failed" | "skipped";
  readonly reason?: string | undefined;
  readonly expected: BenchmarkExpectation;
  readonly actual: {
    readonly finalPhase: string;
    readonly acceptanceStatus: string;
    readonly passedGateCount: number;
    readonly repairCount: number;
    readonly falseSuccess: boolean;
    readonly falseFailure: boolean;
    readonly falseFailureClassified?: boolean | undefined;
    readonly recoveryOutcome?: string | undefined;
    readonly budgetBreached?: boolean | undefined;
    readonly executedCommands?: readonly string[] | undefined;
    readonly source?: ExternalSourceMetadata | undefined;
    readonly modifiedFiles?: readonly string[] | undefined;
    readonly diffFingerprint?: string | undefined;
    readonly secretFindings?: readonly { readonly path: string; readonly ruleId: string }[] | undefined;
    readonly adapterNative?: NativeExecutionMetadata | undefined;
    readonly adapterOutcome?: {
      readonly status: "succeeded" | "failed" | "blocked" | "cancelled" | "invalid";
      readonly failureCode?: string | undefined;
      readonly failureSignature?: string | undefined;
    } | undefined;
    readonly commandEvidence?: readonly BenchmarkCommandEvidence[] | undefined;
    readonly evidenceFacts?: BenchmarkAggregationInput["cases"][number]["evidence"] | undefined;
  };
  readonly metrics?: RunMetrics | undefined;
  readonly error?: string | undefined;
}

export interface GitMetadata {
  readonly revision: string | null;
  readonly isDirty: boolean | null;
}

export interface BenchmarkRunReport {
  readonly schemaVersion: 1;
  readonly benchmarkRunId: string;
  readonly manifestHash: string;
  readonly configHash: string;
  readonly semanticHash: string;
  readonly externalBindingHash?: string | undefined;
  readonly gitMetadata: GitMetadata;
  readonly environment: {
    readonly platform: string;
    readonly nodeVersion: string;
    readonly liveApproved: boolean;
  };
  readonly liveApproved: boolean;
  readonly modelCallCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly skippedCases: number;
  readonly falseSuccessCount: number;
  readonly falseFailureCount: number;
  readonly reliability: BenchmarkAggregate;
  readonly cases: readonly BenchmarkCaseResult[];
}

/**
 * Options for configuring BenchmarkRunner execution.
 *
 * Limitation note: BenchmarkRunner executes cases sequentially without accepting an external AbortSignal.
 * Workspace isolation and cleanup are strictly guaranteed for normal success, staging errors,
 * expectation/assertion mismatches, and adapter execute failures, but mid-run external cancellation / abort cleanup
 * is currently not supported or exposed on this API.
 */
export interface BenchmarkRunnerOptions {
  readonly repoRoot: string;
  readonly manifestPath?: string | undefined;
  readonly allowModelCost?: boolean | undefined;
  readonly processRunner?: ProcessRunner | undefined;
  readonly adapterFactory?: ((caseDef: BenchmarkCase) => AgentAdapter | Promise<AgentAdapter>) | undefined;
  readonly workspaceFactory?: ((caseId: string) => Promise<{ path: string; cleanup: () => Promise<void> }>) | undefined;
  readonly outputDir?: string | undefined;
  readonly now?: (() => string) | undefined;
  readonly activateCaseIds?: readonly string[] | undefined;
  readonly externalBindingPath?: string | undefined;
}

export interface BenchmarkCommandEvidence {
  readonly phase: "setup" | "gate";
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly termination: ProcessResult["termination"];
  readonly exitCode: number | null;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly evidenceId?: string | undefined;
  readonly artifactIds: readonly string[];
}

interface ExternalExecutionContext {
  readonly source: ExternalSourceMetadata;
  readonly beforeSnapshot: WorkspaceSnapshot;
  readonly setupEvidence: readonly BenchmarkCommandEvidence[];
}

class ExternalSetupFailure extends QualityError {
  readonly evidence: readonly BenchmarkCommandEvidence[];

  constructor(evidence: readonly BenchmarkCommandEvidence[]) {
    super(
      "BENCHMARK_WORKSPACE_UNSAFE",
      "[BENCHMARK_EXTERNAL_SETUP_FAILED] Typed setup command did not exit successfully"
    );
    this.evidence = evidence;
  }
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function commandEvidenceFromResult(
  phase: "setup" | "gate",
  request: Pick<ProcessRequest, "command" | "args" | "cwd" | "timeoutMs">,
  result: ProcessResult,
  workspaceDir: string
): BenchmarkCommandEvidence {
  const relativeCwd = path.relative(workspaceDir, request.cwd).replace(/\\/g, "/") || ".";
  return {
    phase,
    command: [request.command, ...request.args],
    cwd: relativeCwd,
    timeoutMs: request.timeoutMs,
    termination: result.termination,
    exitCode: result.exitCode,
    stdoutSummary: truncateUtf8Bytes(result.stdout, 16384),
    stderrSummary: truncateUtf8Bytes(result.stderr, 16384),
    stdoutSha256: sha256Text(result.stdout),
    stderrSha256: sha256Text(result.stderr),
    artifactIds: [],
  };
}

export function getGitMetadata(repoRoot: string): GitMetadata {
  try {
    const resolvedRoot = path.resolve(repoRoot);
    const revOut = child_process.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolvedRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    const statusOut = child_process.execFileSync("git", ["status", "--porcelain"], {
      cwd: resolvedRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });

    const revision = revOut.trim() || null;
    const isDirty = statusOut.trim().length > 0;
    return { revision, isDirty };
  } catch {
    return { revision: null, isDirty: null };
  }
}

export function resolveNpmCliPath(): string {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    if (syncFs.existsSync(c)) {
      return c;
    }
  }
  try {
    return require.resolve("npm/bin/npm-cli.js");
  } catch {
    throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", "Could not locate npm-cli.js in Node installation");
  }
}

export async function copyFileContained(
  src: string,
  dest: string,
  srcRoot: string,
  destRoot: string
): Promise<void> {
  const resolvedSrc = path.resolve(src);
  const resolvedDest = path.resolve(dest);
  const resolvedSrcRoot = path.resolve(srcRoot);
  const resolvedDestRoot = path.resolve(destRoot);

  if (!isBenchmarkPathContained(resolvedSrc, resolvedSrcRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Source path '${resolvedSrc}' escapes source root '${resolvedSrcRoot}'`
    );
  }

  if (!isBenchmarkPathContained(path.dirname(resolvedSrc), resolvedSrcRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Source parent directory '${path.dirname(resolvedSrc)}' escapes source root '${resolvedSrcRoot}'`
    );
  }

  if (!isBenchmarkPathContained(resolvedDest, resolvedDestRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Destination path '${resolvedDest}' escapes destination root '${resolvedDestRoot}'`
    );
  }

  if (!isBenchmarkPathContained(path.dirname(resolvedDest), resolvedDestRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Destination parent directory '${path.dirname(resolvedDest)}' escapes destination root '${resolvedDestRoot}'`
    );
  }

  // Pre-copy source bytes snapshot & hash
  const preSrcBuf = await fs.readFile(resolvedSrc);
  const preSrcHash = crypto.createHash("sha256").update(preSrcBuf).digest("hex");

  await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
  await fs.copyFile(resolvedSrc, resolvedDest);

  // Post-copy verification of bytes, SHA-256 hash, and destination containment
  const destBuf = await fs.readFile(resolvedDest);
  const destHash = crypto.createHash("sha256").update(destBuf).digest("hex");

  if (preSrcHash !== destHash || Buffer.compare(preSrcBuf, destBuf) !== 0) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Post-copy content hash mismatch for '${resolvedDest}'`
    );
  }

  // Re-verify source file was not modified during copy
  const postSrcBuf = await fs.readFile(resolvedSrc);
  if (Buffer.compare(preSrcBuf, postSrcBuf) !== 0) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Source file '${resolvedSrc}' was modified during copy operation`
    );
  }

  const realDest = await fs.realpath(resolvedDest);
  if (!isBenchmarkPathContained(realDest, resolvedDestRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Copied file realpath '${realDest}' escapes destination root '${resolvedDestRoot}'`
    );
  }

  const realDestParent = await fs.realpath(path.dirname(resolvedDest));
  if (!isBenchmarkPathContained(realDestParent, resolvedDestRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Copied file parent realpath '${realDestParent}' escapes destination root '${resolvedDestRoot}'`
    );
  }
}

export async function copyDirectoryContained(
  src: string,
  dest: string,
  srcRoot: string,
  destRoot: string
): Promise<void> {
  const resolvedSrc = path.resolve(src);
  const resolvedDest = path.resolve(dest);
  const resolvedSrcRoot = path.resolve(srcRoot);
  const resolvedDestRoot = path.resolve(destRoot);

  if (!isBenchmarkPathContained(resolvedSrc, resolvedSrcRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Source path '${resolvedSrc}' escapes source root '${resolvedSrcRoot}'`
    );
  }

  if (!isBenchmarkPathContained(resolvedDest, resolvedDestRoot)) {
    throw new QualityError(
      "BENCHMARK_WORKSPACE_UNSAFE",
      `Destination path '${resolvedDest}' escapes destination root '${resolvedDestRoot}'`
    );
  }

  await fs.mkdir(resolvedDest, { recursive: true });
  const entries = await fs.readdir(resolvedSrc, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(resolvedSrc, entry.name);
    const destPath = path.join(resolvedDest, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      await copyDirectoryContained(srcPath, destPath, resolvedSrcRoot, resolvedDestRoot);
    } else if (entry.isSymbolicLink()) {
      const realEntry = await fs.realpath(srcPath);
      if (!isBenchmarkPathContained(realEntry, resolvedSrcRoot)) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          `Symlink '${srcPath}' points to '${realEntry}' outside source root '${resolvedSrcRoot}'`
        );
      }
      const stat = await fs.stat(srcPath);
      if (stat.isDirectory()) {
        await copyDirectoryContained(srcPath, destPath, resolvedSrcRoot, resolvedDestRoot);
      } else {
        await copyFileContained(srcPath, destPath, resolvedSrcRoot, resolvedDestRoot);
      }
    } else {
      await copyFileContained(srcPath, destPath, resolvedSrcRoot, resolvedDestRoot);
    }
  }
}

/**
 * Runner that executes benchmark test suites across isolated workspaces.
 *
 * Limitation note: BenchmarkRunner executes cases sequentially without accepting an external AbortSignal.
 * Workspace isolation and cleanup are strictly guaranteed for normal success, staging errors,
 * expectation/assertion mismatches, and adapter execute failures, but mid-run external cancellation / abort cleanup
 * is currently not supported or exposed on this API.
 */
export class BenchmarkRunner {
  private readonly options: BenchmarkRunnerOptions;
  private modelCallCount: number = 0;

  constructor(options: BenchmarkRunnerOptions) {
    this.options = options;
  }

  async run(): Promise<BenchmarkRunReport> {
    this.modelCallCount = 0;
    const startedAt = this.options.now ? this.options.now() : new Date().toISOString();
    const startTime = Date.now();
    const benchmarkRunId = `bm-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    const manifestPath = this.options.manifestPath ?? path.join("benchmarks", "v4", "manifest.json");
    const resolvedManifestPath = path.resolve(this.options.repoRoot, manifestPath);

    const manifest = await loadBenchmarkManifest(
      this.options.repoRoot,
      this.options.manifestPath
    );

    const requestedActivations = this.options.activateCaseIds ?? [];
    const activationSet = new Set(requestedActivations);
    if (activationSet.size !== requestedActivations.length) {
      throw new QualityError(
        "BENCHMARK_MANIFEST_INVALID",
        "[BENCHMARK_ACTIVATION_INVALID] Activation case IDs must be unique"
      );
    }
    const manifestCaseIds = new Set(manifest.cases.map((item) => item.id));
    for (const caseId of activationSet) {
      if (!manifestCaseIds.has(caseId)) {
        throw new QualityError(
          "BENCHMARK_MANIFEST_INVALID",
          `[BENCHMARK_ACTIVATION_INVALID] Unknown benchmark case ID '${caseId}'`
        );
      }
    }

    let manifestRaw = "";
    try {
      manifestRaw = await fs.readFile(resolvedManifestPath, "utf-8");
    } catch {
      manifestRaw = JSON.stringify(manifest);
    }

    const manifestHash = crypto.createHash("sha256").update(manifestRaw).digest("hex");
    let externalBindingHash: string | undefined;
    if (this.options.externalBindingPath) {
      try {
        const bindingBytes = await fs.readFile(
          path.resolve(this.options.repoRoot, this.options.externalBindingPath)
        );
        externalBindingHash = crypto.createHash("sha256").update(bindingBytes).digest("hex");
      } catch {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          "[BENCHMARK_EXTERNAL_BINDING_INVALID] Binding file is missing or unreadable"
        );
      }
    }
    // Relative config hash without absolute repoRoot
    const configHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          allowModelCost: Boolean(this.options.allowModelCost),
          activateCaseIds: [...activationSet].sort(),
          externalBindingHash: externalBindingHash ?? null,
        })
      )
      .digest("hex");

    const gitMetadata = getGitMetadata(path.resolve(this.options.repoRoot));
    const isGlobalLiveAllowed =
      this.options.allowModelCost === true && process.env.OMNI_V4_ALLOW_MODEL_COST === "1";

    const caseResults: BenchmarkCaseResult[] = [];
    let passedCases = 0;
    let failedCases = 0;
    let skippedCases = 0;
    let falseSuccessCount = 0;
    let falseFailureCount = 0;

    for (const c of manifest.cases) {
      const isEnabled = c.enabled || activationSet.has(c.id);
      if (!isEnabled) {
        skippedCases++;
        caseResults.push({
          id: c.id,
          enabled: false,
          status: "skipped",
          reason: "Case is disabled in manifest",
          expected: c.expected,
          actual: {
            finalPhase: "NONE",
            acceptanceStatus: "none",
            passedGateCount: 0,
            repairCount: 0,
            falseSuccess: false,
            falseFailure: false,
            executedCommands: [],
            evidenceFacts: {
              runIdentityRecorded: false,
              expectedOutcomeRecorded: true,
              mandatoryGateEvidenceComplete: false,
              acceptanceEvidenceComplete: false,
            },
          },
        });
        continue;
      }

      // Three-part opt-in check: Non-fake cases require manifest liveModelCostOptIn=true, process.env.OMNI_V4_ALLOW_MODEL_COST="1", and runner allowModelCost=true
      const isCaseLiveApproved =
        c.liveModelCostOptIn === true &&
        process.env.OMNI_V4_ALLOW_MODEL_COST === "1" &&
        this.options.allowModelCost === true;

      if (c.adapter !== "fake" && !isCaseLiveApproved) {
        skippedCases++;
        caseResults.push({
          id: c.id,
          enabled: isEnabled,
          status: "skipped",
          reason: "[LIVE_BENCHMARK_NOT_APPROVED] Live model cost is not approved (requires manifest liveModelCostOptIn=true, process.env.OMNI_V4_ALLOW_MODEL_COST=1, and runner allowModelCost=true)",
          expected: c.expected,
          actual: {
            finalPhase: "NONE",
            acceptanceStatus: "none",
            passedGateCount: 0,
            repairCount: 0,
            falseSuccess: false,
            falseFailure: false,
            executedCommands: [],
            evidenceFacts: {
              runIdentityRecorded: false,
              expectedOutcomeRecorded: true,
              mandatoryGateEvidenceComplete: false,
              acceptanceEvidenceComplete: false,
            },
          },
        });
        continue;
      }

      // Create owned isolated temporary workspace via factory or mkdtemp
      let tmpWorkspace: string;
      let workspaceCleanup: (() => Promise<void>) | undefined;

      if (this.options.workspaceFactory) {
        const wsObj = await this.options.workspaceFactory(c.id);
        tmpWorkspace = wsObj.path;
        workspaceCleanup = wsObj.cleanup;
      } else {
        tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), `omni-bm-case-${c.id}-`));
        workspaceCleanup = async () => {
          await fs.rm(tmpWorkspace, { recursive: true, force: true }).catch(() => {});
        };
      }

      let externalSource: ExternalSourceMetadata | undefined;
      let setupEvidence: readonly BenchmarkCommandEvidence[] = [];
      try {
        let externalBinding: ExternalCaseBinding | undefined;
        if (
          c.projectKind === "javascript" ||
          c.projectKind === "non-javascript" ||
          c.projectKind === "unusual-tests"
        ) {
          if (!this.options.externalBindingPath) {
            throw new QualityError(
              "BENCHMARK_WORKSPACE_UNSAFE",
              "[BENCHMARK_EXTERNAL_BINDING_MISSING] Activated external case requires a local binding file"
            );
          }
          const bindings = await loadExternalBindings(
            path.resolve(this.options.repoRoot, this.options.externalBindingPath)
          );
          externalBinding = requireExternalCaseBinding(bindings, c.id);
          if (!c.liveTask) {
            throw new QualityError(
              "BENCHMARK_WORKSPACE_UNSAFE",
              "[BENCHMARK_EXTERNAL_CONTRACT_MISSING] External case must declare liveTask"
            );
          }
          enforceExternalBindingContract(externalBinding, {
            requiredDependencyPolicy: c.liveTask.requiredDependencyPolicy,
            requiredToolchain: c.liveTask.requiredToolchain,
          });
        }

        const source = await this.stageWorkspace(c, tmpWorkspace, externalBinding);
        externalSource = source;
        let externalContext: ExternalExecutionContext | undefined;
        if (source && c.liveTask) {
          setupEvidence = await this.runExternalSetup(c, tmpWorkspace);
          externalContext = {
            source,
            beforeSnapshot: await captureWorkspaceSnapshot(tmpWorkspace),
            setupEvidence,
          };
        }

        const runResult = await this.executeCase(c, tmpWorkspace, externalContext);
        caseResults.push(runResult);

        if (runResult.status === "passed") {
          passedCases++;
        } else if (runResult.status === "failed") {
          failedCases++;
        } else {
          skippedCases++;
        }

        if (runResult.actual.falseSuccess) {
          falseSuccessCount++;
        }
        if (runResult.actual.falseFailure) {
          falseFailureCount++;
        }
      } catch (err: unknown) {
        failedCases++;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof ExternalSetupFailure) {
          setupEvidence = err.evidence;
        }
        caseResults.push({
          id: c.id,
          enabled: isEnabled,
          status: "failed",
          error: errMsg,
          expected: c.expected,
          actual: {
            finalPhase: "ERROR",
            acceptanceStatus: "failed",
            passedGateCount: 0,
            repairCount: 0,
            falseSuccess: false,
            falseFailure: false,
            executedCommands: setupEvidence.map((item) => item.command.join(" ")),
            commandEvidence: setupEvidence,
            evidenceFacts: {
              runIdentityRecorded: false,
              expectedOutcomeRecorded: true,
              mandatoryGateEvidenceComplete: false,
              acceptanceEvidenceComplete: false,
            },
            source: externalSource
              ? { ...externalSource, repositoryRoot: "<external-root>" }
              : undefined,
          },
        });
      } finally {
        if (workspaceCleanup) {
          await workspaceCleanup().catch(() => {});
        }
      }
    }

    const completedAt = this.options.now ? this.options.now() : new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const reliability = aggregateBenchmarkReliability({
      schemaVersion: 1,
      threshold: 0.9,
      cases: caseResults.map((result) => {
        const caseDefinition = manifest.cases.find((item) => item.id === result.id);
        if (!caseDefinition) {
          throw new Error(`Benchmark result '${result.id}' has no manifest definition`);
        }
        const evidence = result.actual.evidenceFacts ?? {
          runIdentityRecorded: false,
          expectedOutcomeRecorded: false,
          mandatoryGateEvidenceComplete: false,
          acceptanceEvidenceComplete: false,
        };
        const acceptanceSatisfied = result.actual.acceptanceStatus === "accepted";
        const workingResult =
          result.status === "passed" &&
          acceptanceSatisfied &&
          ["ACCEPT", "DOCUMENT", "READY"].includes(result.actual.finalPhase);
        const mandatoryGatesPassed =
          result.status === "passed" &&
          result.actual.passedGateCount >= (result.expected.minPassedGates ?? 0);
        return {
          id: result.id,
          applicability: caseDefinition.applicability,
          workingResult,
          mandatoryGatesPassed,
          acceptanceSatisfied,
          evidence,
          falseSuccess: result.actual.falseSuccess,
        };
      }),
    });

    const preliminaryReport: BenchmarkRunReport = {
      schemaVersion: 1,
      benchmarkRunId,
      manifestHash,
      configHash,
      semanticHash: "",
      ...(externalBindingHash ? { externalBindingHash } : {}),
      gitMetadata,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
        liveApproved: isGlobalLiveAllowed,
      },
      liveApproved: isGlobalLiveAllowed,
      modelCallCount: this.modelCallCount,
      startedAt,
      completedAt,
      durationMs,
      totalCases: manifest.cases.length,
      passedCases,
      failedCases,
      skippedCases,
      falseSuccessCount,
      falseFailureCount,
      reliability,
      cases: caseResults,
    };

    const semanticHash = computeSemanticHash(preliminaryReport);

    return {
      ...preliminaryReport,
      semanticHash,
    };
  }

  private async stageWorkspace(
    c: BenchmarkCase,
    tmpWorkspace: string,
    externalBinding?: ExternalCaseBinding
  ): Promise<ExternalSourceMetadata | undefined> {
    const repoRoot = path.resolve(this.options.repoRoot);

    if (externalBinding) {
      if (!c.liveTask) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          "[BENCHMARK_EXTERNAL_CONTRACT_MISSING] External case must declare liveTask"
        );
      }
      const source = await stagePinnedTrackedTree(externalBinding, tmpWorkspace);
      const sdlcDir = path.join(tmpWorkspace, ".omni", "sdlc");
      const v4Dir = path.join(tmpWorkspace, ".omni", "v4");
      await fs.mkdir(sdlcDir, { recursive: true });
      await fs.mkdir(v4Dir, { recursive: true });

      const requirementLines = c.liveTask.requirements.map((requirement) => {
        const gate = c.liveTask!.gates.find((candidate) =>
          candidate.requirementIds.includes(requirement.id as never)
        );
        const strategy = gate ? [gate.command, ...gate.args].join(" ") : "agent";
        return `- [ ] ${requirement.id} | ${requirement.text} | test: ${strategy}`;
      });
      await fs.writeFile(
        path.join(sdlcDir, "requirements.md"),
        `# External Benchmark Requirements\n${requirementLines.join("\n")}\n`,
        "utf-8"
      );
      await fs.writeFile(
        path.join(v4Dir, "quality.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            requirementsPath: ".omni/sdlc/requirements.md",
            maxParallelGates: 2,
            outputSummaryBytes: c.liveTask.outputSummaryBytes ?? 16384,
            gates: c.liveTask.gates,
          },
          null,
          2
        ),
        "utf-8"
      );
      return source;
    } else if (c.projectKind === "fixture" && c.fixturePath) {
      const srcFixture = path.resolve(repoRoot, c.fixturePath);
      await copyDirectoryContained(srcFixture, tmpWorkspace, repoRoot, tmpWorkspace);
    } else if (c.projectKind === "omni") {
      // Real dogfood staging: stage actual repo inputs needed to execute actual npm scripts
      const pkgJson = path.resolve(repoRoot, "package.json");
      const tsConfigV4 = path.resolve(repoRoot, "tsconfig.v4.json");
      const testRunnerScript = path.resolve(repoRoot, "scripts", "run-v4-tests.cjs");

      if (!syncFs.existsSync(pkgJson)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `package.json not found at ${pkgJson}`);
      }
      if (!syncFs.existsSync(tsConfigV4)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `tsconfig.v4.json not found at ${tsConfigV4}`);
      }
      if (!syncFs.existsSync(testRunnerScript)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `scripts/run-v4-tests.cjs not found at ${testRunnerScript}`);
      }

      await copyFileContained(pkgJson, path.join(tmpWorkspace, "package.json"), repoRoot, tmpWorkspace);
      await copyFileContained(tsConfigV4, path.join(tmpWorkspace, "tsconfig.v4.json"), repoRoot, tmpWorkspace);
      await copyFileContained(testRunnerScript, path.join(tmpWorkspace, "scripts", "run-v4-tests.cjs"), repoRoot, tmpWorkspace);

      const srcDir = path.resolve(repoRoot, "src");
      if (!syncFs.existsSync(srcDir)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `src directory not found at ${srcDir}`);
      }
      await copyDirectoryContained(srcDir, path.join(tmpWorkspace, "src"), repoRoot, tmpWorkspace);

      // Stage compatibility/v4 metadata
      const compatDir = path.resolve(repoRoot, "compatibility", "v4");
      if (!syncFs.existsSync(compatDir)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `compatibility/v4 directory not found at ${compatDir}`);
      }
      await copyDirectoryContained(compatDir, path.join(tmpWorkspace, "compatibility", "v4"), repoRoot, tmpWorkspace);

      // Stage test/fixtures/v4 fixtures required by unit tests
      const testFixturesDir = path.resolve(repoRoot, "test", "fixtures", "v4");
      if (!syncFs.existsSync(testFixturesDir)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `test/fixtures/v4 directory not found at ${testFixturesDir}`);
      }
      await copyDirectoryContained(testFixturesDir, path.join(tmpWorkspace, "test", "fixtures", "v4"), repoRoot, tmpWorkspace);

      // Stage test/v4 files excluding benchmark and traceability suites to prevent recursion/failures
      const testV4Dir = path.resolve(repoRoot, "test", "v4");
      if (!syncFs.existsSync(testV4Dir)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `test/v4 directory not found at ${testV4Dir}`);
      }
      const destTestV4 = path.join(tmpWorkspace, "test", "v4");
      await fs.mkdir(destTestV4, { recursive: true });

      const testEntries = await fs.readdir(testV4Dir, { withFileTypes: true });
      for (const entry of testEntries) {
        if (
          entry.isFile() &&
          entry.name.endsWith(".test.ts") &&
          !entry.name.startsWith("benchmark") &&
          entry.name !== "report.test.ts" &&
          entry.name !== "requirements-traceability.test.ts"
        ) {
          await copyFileContained(
            path.join(testV4Dir, entry.name),
            path.join(destTestV4, entry.name),
            repoRoot,
            tmpWorkspace
          );
        }
      }

      // Safely link existing dependencies into tmpWorkspace without npm install - fail closed if missing
      const repoNodeModules = path.resolve(repoRoot, "node_modules");
      const wsNodeModules = path.join(tmpWorkspace, "node_modules");
      if (!syncFs.existsSync(repoNodeModules)) {
        throw new QualityError("BENCHMARK_WORKSPACE_UNSAFE", `Host node_modules not found at ${repoNodeModules}`);
      }

      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      try {
        await fs.symlink(repoNodeModules, wsNodeModules, symlinkType);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          `Failed to link node_modules to workspace: ${errMsg}`
        );
      }

      const sdlcDir = path.join(tmpWorkspace, ".omni", "sdlc");
      const v4Dir = path.join(tmpWorkspace, ".omni", "v4");
      await fs.mkdir(sdlcDir, { recursive: true });
      await fs.mkdir(v4Dir, { recursive: true });

      await fs.writeFile(
        path.join(sdlcDir, "requirements.md"),
        `# Omni Self Requirements\n` +
          `- [ ] R1 | Omni v4 TypeScript Build | test: npm run build:v4\n` +
          `- [ ] R2 | Omni v4 Typecheck | test: npm run typecheck:v4\n` +
          `- [ ] R3 | Omni v4 Quality Contracts Test | test: npm run test:v4\n`,
        "utf-8"
      );

      const npmCli = resolveNpmCliPath();
      await fs.writeFile(
        path.join(v4Dir, "quality.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            requirementsPath: ".omni/sdlc/requirements.md",
            maxParallelGates: 2,
            gates: [
              {
                id: "npm-build-v4",
                command: process.execPath,
                args: [npmCli, "run", "build:v4"],
                cwd: ".",
                timeoutMs: 60000,
                mandatory: true,
                requirementIds: ["R1"],
                dependsOn: [],
                sideEffect: "read-only",
                retrySafe: true,
              },
              {
                id: "npm-typecheck-v4",
                command: process.execPath,
                args: [npmCli, "run", "typecheck:v4"],
                cwd: ".",
                timeoutMs: 60000,
                mandatory: true,
                requirementIds: ["R2"],
                dependsOn: [],
                sideEffect: "read-only",
                retrySafe: true,
              },
              {
                id: "npm-test-v4",
                command: process.execPath,
                args: [npmCli, "run", "test:v4"],
                cwd: ".",
                timeoutMs: 120000,
                mandatory: true,
                requirementIds: ["R3"],
                dependsOn: ["npm-build-v4", "npm-typecheck-v4"],
                sideEffect: "read-only",
                retrySafe: true,
              },
            ],
          },
          null,
          2
        ),
        "utf-8"
      );
    } else if (c.repositoryPath) {
      const srcRepo = path.resolve(repoRoot, c.repositoryPath);
      if (syncFs.existsSync(srcRepo)) {
        await copyDirectoryContained(srcRepo, tmpWorkspace, repoRoot, tmpWorkspace);
      }
    }
    return undefined;
  }

  private async runExternalSetup(
    c: BenchmarkCase,
    workspaceDir: string
  ): Promise<readonly BenchmarkCommandEvidence[]> {
    if (!c.liveTask) return [];
    const runner = this.options.processRunner ?? new NodeProcessRunner();
    const evidence: BenchmarkCommandEvidence[] = [];
    for (const command of c.liveTask.setupCommands) {
      const cwd = path.resolve(workspaceDir, command.cwd);
      const relativeCwd = path.relative(workspaceDir, cwd);
      if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          "[BENCHMARK_EXTERNAL_SETUP_UNSAFE] Setup cwd escapes the owned workspace"
        );
      }
      const request = {
        command: command.program,
        args: command.args,
        cwd,
        timeoutMs: command.timeoutMs,
      } satisfies ProcessRequest;
      const result = await runner.run(request);
      evidence.push(commandEvidenceFromResult("setup", request, result, workspaceDir));
      if (result.termination !== "exited" || result.exitCode !== 0) {
        throw new ExternalSetupFailure(evidence);
      }
    }
    return evidence;
  }

  private async executeCase(
    c: BenchmarkCase,
    workspaceDir: string,
    externalContext?: ExternalExecutionContext
  ): Promise<BenchmarkCaseResult> {
    const runId = asRunId(`run-bm-${c.id}`);
    const events = new FileEventStore({ projectDir: workspaceDir });
    const bundles = new EvidenceBundleStore({ projectRoot: workspaceDir });

    // Handle adapter resolution and live operation execution seam
    let adapter: AgentAdapter;
    let adapterNative: NativeExecutionMetadata | undefined;
    let adapterCliVersion: string | undefined;
    let adapterOutcome: BenchmarkCaseResult["actual"]["adapterOutcome"];
    let adapterExecutionAttempted = false;
    let diffEvidence: WorkspaceDiffEvidence | undefined;
    try {
    if (c.adapter === "fake") {
      adapter = new FakeAdapter({ outcomes: [] });
    } else {
      if (this.options.adapterFactory) {
        adapter = await this.options.adapterFactory(c);
      } else {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          `[LIVE_ADAPTER_UNAVAILABLE] No live adapter configured for ${c.adapter}`
        );
      }
      const adapterProbe = await adapter.probe();
      if (!adapterProbe.available) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          `[LIVE_ADAPTER_UNAVAILABLE] Adapter ${c.adapter} is not available`
        );
      }
      const missingCapabilities = (c.liveTask?.requiredCapabilities ?? []).filter(
        (capability) => !adapterProbe.capabilities.includes(capability)
      );
      if (missingCapabilities.length > 0) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          `[LIVE_ADAPTER_CAPABILITY_MISSING] Adapter ${c.adapter} lacks required capabilities: ${missingCapabilities.join(", ")}`
        );
      }
      adapterCliVersion = adapterProbe.version;
      // Execute the live adapter seam operation - record call attempt at exact boundary before await
      adapterExecutionAttempted = true;
      this.modelCallCount++;
      const operationId = `live-exec-${c.id}`;
      const rawAdapterResult = await adapter.execute(
        {
          runId,
          stepId: asStepId("s-live-exec"),
          phase: "EXECUTE",
          operationId,
          workspaceDir,
          prompt: c.liveTask?.prompt ?? "Execute benchmark step",
          requiredCapabilities: c.liveTask?.requiredCapabilities ?? [],
          sideEffect: c.liveTask?.sideEffect ?? "read-only",
          timeoutMs: c.liveTask?.timeoutMs ?? 60000,
        },
        {
          signal: new AbortController().signal,
          elevatedPermissions: false,
        }
      );

      const parsedAdapterResult = StepResultSchema.safeParse(rawAdapterResult);
      if (parsedAdapterResult.success) {
        adapterNative = {
          ...parsedAdapterResult.data.native,
          ...(adapterCliVersion ? { cliVersion: adapterCliVersion } : {}),
        };
        if (Object.keys(adapterNative).length === 0) {
          adapterNative = undefined;
        }
        adapterOutcome =
          parsedAdapterResult.data.status === "failed"
            ? {
                status: "failed",
                failureCode: parsedAdapterResult.data.failure.code,
                failureSignature: parsedAdapterResult.data.failure.signature,
              }
            : { status: parsedAdapterResult.data.status };
      } else {
        adapterOutcome = { status: "invalid" };
      }

      if (externalContext && c.liveTask) {
        const afterSnapshot = await captureWorkspaceSnapshot(workspaceDir);
        diffEvidence = compareWorkspaceSnapshots(
          externalContext.beforeSnapshot,
          afterSnapshot,
          c.liveTask.allowedPaths,
          c.liveTask.allowedPathPrefixes
        );
      }

      if (!parsedAdapterResult.success) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          "[BENCHMARK_ADAPTER_RESULT_INVALID] Live adapter returned a schema-invalid result"
        );
      }
      if (parsedAdapterResult.data.executionId !== operationId) {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          "[BENCHMARK_ADAPTER_EXECUTION_MISMATCH] Live adapter result is not correlated to the requested operation"
        );
      }
      if (parsedAdapterResult.data.status !== "succeeded") {
        throw new QualityError(
          "BENCHMARK_WORKSPACE_UNSAFE",
          `[BENCHMARK_ADAPTER_NOT_SUCCEEDED] Live adapter ended with status '${parsedAdapterResult.data.status}'`
        );
      }
      if (externalContext && c.liveTask) {
        if (!diffEvidence || diffEvidence.modifiedFiles.length === 0) {
          throw new QualityError(
            "BENCHMARK_WORKSPACE_UNSAFE",
            "[BENCHMARK_EXTERNAL_MUTATION_REQUIRED] Adapter reported success without a required source mutation"
          );
        }
      }
    }
    } catch (err: unknown) {
      if (err instanceof WorkspaceDiffViolation) {
        diffEvidence = err.evidence;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        id: c.id,
        enabled: true,
        status: "failed",
        error: errMsg,
        expected: c.expected,
        actual: {
          finalPhase: "ERROR",
          acceptanceStatus: "failed",
          passedGateCount: 0,
          repairCount: 0,
          falseSuccess: false,
          falseFailure: false,
          falseFailureClassified: !adapterExecutionAttempted,
          executedCommands: externalContext?.setupEvidence.map((item) => item.command.join(" ")) ?? [],
          commandEvidence: externalContext?.setupEvidence ?? [],
          source: externalContext
            ? { ...externalContext.source, repositoryRoot: "<external-root>" }
            : undefined,
          modifiedFiles: diffEvidence?.modifiedFiles,
          diffFingerprint: diffEvidence?.patchSha256,
          secretFindings: diffEvidence?.secretFindings,
          adapterNative,
          adapterOutcome,
        },
      };
    }

    // 1. Initial run.created and lifecycle transition events reaching VERIFY phase
    const initEvents: RunEvent[] = [
      {
        schemaVersion: 1,
        eventId: asEventId("ev-0"),
        runId,
        sequence: 0,
        at: "2026-08-20T10:00:00.000Z",
        type: "run.created",
        payload: { startedAt: "2026-08-20T10:00:00.000Z" },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-1"),
        runId,
        sequence: 1,
        at: "2026-08-20T10:00:01.000Z",
        type: "step.started",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          phase: "INTAKE",
          sideEffect: "read-only",
          workspaceDir,
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-2"),
        runId,
        sequence: 2,
        at: "2026-08-20T10:00:02.000Z",
        type: "step.succeeded",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          result: {
            status: "succeeded",
            executionId: "op-1",
            summary: "intake complete",
            artifacts: [],
            evidence: [],
          },
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-3"),
        runId,
        sequence: 3,
        at: "2026-08-20T10:00:03.000Z",
        type: "run.transitioned",
        payload: {
          stepId: asStepId("s-1"),
          operationId: "op-1",
          from: "INTAKE",
          to: "PLAN",
          causedByEventId: asEventId("ev-2"),
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-4"),
        runId,
        sequence: 4,
        at: "2026-08-20T10:00:04.000Z",
        type: "step.started",
        payload: {
          stepId: asStepId("s-2"),
          operationId: "op-2",
          phase: "PLAN",
          sideEffect: "read-only",
          workspaceDir,
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-5"),
        runId,
        sequence: 5,
        at: "2026-08-20T10:00:05.000Z",
        type: "step.succeeded",
        payload: {
          stepId: asStepId("s-2"),
          operationId: "op-2",
          result: {
            status: "succeeded",
            executionId: "op-2",
            summary: "plan complete",
            artifacts: [],
            evidence: [],
          },
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-6"),
        runId,
        sequence: 6,
        at: "2026-08-20T10:00:06.000Z",
        type: "run.transitioned",
        payload: {
          stepId: asStepId("s-2"),
          operationId: "op-2",
          from: "PLAN",
          to: "EXECUTE",
          causedByEventId: asEventId("ev-5"),
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-7"),
        runId,
        sequence: 7,
        at: "2026-08-20T10:00:07.000Z",
        type: "step.started",
        payload: {
          stepId: asStepId("s-3"),
          operationId: "op-3",
          phase: "EXECUTE",
          sideEffect: "workspace-write",
          workspaceDir,
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-8"),
        runId,
        sequence: 8,
        at: "2026-08-20T10:00:08.000Z",
        type: "step.succeeded",
        payload: {
          stepId: asStepId("s-3"),
          operationId: "op-3",
          result: {
            status: "succeeded",
            executionId: "op-3",
            summary: "execute complete",
            artifacts: [],
            evidence: [],
          },
        },
      },
      {
        schemaVersion: 1,
        eventId: asEventId("ev-9"),
        runId,
        sequence: 9,
        at: "2026-08-20T10:00:09.000Z",
        type: "run.transitioned",
        payload: {
          stepId: asStepId("s-3"),
          operationId: "op-3",
          from: "EXECUTE",
          to: "VERIFY",
          causedByEventId: asEventId("ev-8"),
        },
      },
    ];

    for (let i = 0; i < initEvents.length; i++) {
      await events.append(initEvents[i]!, i - 1);
    }

    // 2. Load config and requirements
    let config;
    try {
      config = await loadQualityConfig(workspaceDir);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const metrics = await MetricsCollector.collect({ runId, events: await events.read(runId) });
      const recordedEvents = await events.read(runId);
      const matchesPhase = c.expected.finalPhase === "BLOCKED";
      return {
        id: c.id,
        enabled: true,
        status: matchesPhase ? "passed" : "failed",
        reason: errMsg,
        expected: c.expected,
        actual: {
          finalPhase: "BLOCKED",
          acceptanceStatus: "none",
          passedGateCount: 0,
          repairCount: 0,
          falseSuccess: false,
          falseFailure: false,
          executedCommands: [],
          evidenceFacts: {
            runIdentityRecorded: recordedEvents.some(
              (event) => event.runId === runId && event.type === "run.created"
            ),
            expectedOutcomeRecorded: true,
            mandatoryGateEvidenceComplete: false,
            acceptanceEvidenceComplete: false,
          },
        },
        metrics,
      };
    }

    const reqFile = path.join(workspaceDir, config.requirementsPath);
    const reqMarkdown = await fs.readFile(reqFile, "utf-8");
    const reqs = loadRequirements(reqMarkdown);

    const registry = new GateRegistry(config, reqs);
    const baseProcessRunner = this.options.processRunner ?? new NodeProcessRunner();
    const executedCommands: string[] = externalContext
      ? externalContext.setupEvidence.map((item) => item.command.join(" "))
      : [];
    const recordingRunner: ProcessRunner = {
      run: async (req) => {
        const cmdStr =
          req.command === process.execPath && req.args.length >= 3 && req.args[1] === "run"
            ? `npm ${req.args.slice(1).join(" ")}`
            : `${req.command} ${req.args.join(" ")}`;
        executedCommands.push(cmdStr);
        return baseProcessRunner.run(req);
      },
    };

    const gateRunner = new GateRunner();
    const acceptanceEngine = new AcceptanceEngine();
    const repairPolicy = new RepairPolicy({
      maxRepairs: config.maxRepairAttemptsPerRequirement ?? 2,
    });
    const scheduler = new GateScheduler({ maxParallelGates: config.maxParallelGates });

    const coordinator = new QualityCoordinator({
      projectRoot: workspaceDir,
      events,
      bundles,
      registry,
      gateRunner,
      acceptanceEngine,
      repairPolicy,
      scheduler,
      processRunner: recordingRunner,
    });

    const scenario = c.scenario ?? "standard";
    let finalPhase: RunPhase = "VERIFY";
    let finalAcceptanceStatus = "none";
    let passedGates = 0;
    let repairCount = 0;
    let recoveryOutcome: string | undefined;
    let budgetBreached: boolean | undefined;
    const allBundles: EvidenceBundle[] = [];

    // Run first quality cycle in VERIFY
    const cycle1 = await coordinator.runCycle(
      runId,
      "VERIFY",
      0,
      config.maxRepairAttemptsPerRequirement ?? 2
    );
    if (cycle1.bundle) {
      allBundles.push(cycle1.bundle);
      for (const g of cycle1.bundle.gates) {
        if (g.status === "passed") passedGates++;
      }
    }

    if (scenario === "crash-resume") {
      // Simulate crash immediately after quality.completed before route: recover run
      finalPhase = cycle1.decision.kind === "advance" ? cycle1.decision.to : "VERIFY";
      const policy = createDefaultPolicy();
      const resumeResult = await recoverRun(
        {
          adapter,
          events,
          bundles,
          artifacts: {
            record: async () => {
              throw new Error("Artifact record not required during recovery test");
            },
            verify: async () => ({ valid: true }),
          },
          policy,
          gateRegistry: registry,
          newEventId: () => asEventId(crypto.randomUUID()),
          now: () => new Date().toISOString(),
        },
        runId
      );
      recoveryOutcome = resumeResult.kind;
      if (resumeResult.kind === "continue") {
        finalPhase = resumeResult.state.phase;
      } else if (resumeResult.kind === "blocked") {
        finalPhase = "BLOCKED";
      }
    } else if (scenario === "repair-progress") {
      if (cycle1.decision.kind === "repair") {
        finalPhase = cycle1.decision.to;
        repairCount++;

        // Execute scenario repair action: create fixed.txt
        await fs.writeFile(path.join(workspaceDir, "fixed.txt"), "fixed", "utf-8");

        // Run cycle 2 in VERIFY
        const cycle2 = await coordinator.runCycle(
          runId,
          "VERIFY",
          1,
          config.maxRepairAttemptsPerRequirement ?? 2
        );
        if (cycle2.bundle) {
          allBundles.push(cycle2.bundle);
          for (const g of cycle2.bundle.gates) {
            if (g.status === "passed") passedGates++;
          }
        }

        if (cycle2.decision.kind === "advance") {
          finalPhase = cycle2.decision.to;
          if (cycle2.decision.to === "ACCEPT") {
            const cycle3 = await coordinator.runCycle(
              runId,
              "ACCEPT",
              0,
              config.maxRepairAttemptsPerRequirement ?? 2
            );
            if (cycle3.bundle) {
              allBundles.push(cycle3.bundle);
            }
            if (cycle3.decision.kind === "advance") {
              finalPhase = cycle3.decision.to;
            }
          }
        }
      }
    } else if (scenario === "repair-no-progress") {
      if (cycle1.decision.kind === "repair") {
        finalPhase = cycle1.decision.to;
        repairCount++;

        // Run cycle 2 without changes -> triggers REPAIR_NO_PROGRESS
        const cycle2 = await coordinator.runCycle(
          runId,
          "VERIFY",
          1,
          config.maxRepairAttemptsPerRequirement ?? 2
        );
        if (cycle2.bundle) {
          allBundles.push(cycle2.bundle);
        }
        if (cycle2.decision.kind === "block") {
          finalPhase = "BLOCKED";
        }
      }
    } else {
      // Standard scenario
      if (cycle1.decision.kind === "advance") {
        finalPhase = cycle1.decision.to;
        if (cycle1.decision.to === "ACCEPT") {
          // Run ACCEPT cycle
          const cycle2 = await coordinator.runCycle(
            runId,
            "ACCEPT",
            0,
            config.maxRepairAttemptsPerRequirement ?? 2
          );
          if (cycle2.bundle) {
            allBundles.push(cycle2.bundle);
          }
          if (cycle2.decision.kind === "advance") {
            finalPhase = cycle2.decision.to;
          } else if (cycle2.decision.kind === "repair") {
            finalPhase = cycle2.decision.to;
            repairCount++;
          } else if (cycle2.decision.kind === "block") {
            finalPhase = "BLOCKED";
          }
        }
      } else if (cycle1.decision.kind === "repair") {
        finalPhase = cycle1.decision.to;
        repairCount++;
      } else if (cycle1.decision.kind === "block") {
        finalPhase = "BLOCKED";
      }
    }

    // Compute unique passed gates across all executed cycles
    const passedGateIds = new Set<string>();
    for (const b of allBundles) {
      for (const g of b.gates) {
        if (g.status === "passed") {
          passedGateIds.add(g.gateId);
        }
      }
    }
    passedGates = passedGateIds.size;

    // Evaluate final acceptance status from latest bundle verdicts
    const lastBundle = allBundles[allBundles.length - 1];
    if (lastBundle) {
      const allAccepted =
        lastBundle.verdicts.length > 0 &&
        lastBundle.verdicts.every((v) => v.status === "accepted");
      const anyRejected = lastBundle.verdicts.some((v) => v.status === "rejected");
      if (allAccepted) {
        finalAcceptanceStatus = "accepted";
      } else if (anyRejected) {
        finalAcceptanceStatus = "rejected";
      } else if (lastBundle.verdicts.length > 0) {
        finalAcceptanceStatus = "inconclusive";
      }
    }

    const allEvents = await events.read(runId);
    const metrics = await MetricsCollector.collect({
      runId,
      events: allEvents,
      bundleStore: bundles,
      state: { phase: finalPhase, runId },
    });

    if (config.budgets) {
      const budgetEval = BudgetPolicy.evaluate(
        config.budgets,
        metrics,
        cycle1.decision
      );
      if (!budgetEval.passed) {
        budgetBreached = true;
        if (budgetEval.adjustedDecision?.kind === "block") {
          finalPhase = "BLOCKED";
          finalAcceptanceStatus = "none";
        }
      } else {
        budgetBreached = false;
      }
    }

    // Evaluate all declared expectations with fail-closed strict comparisons and structured mismatch reporting
    const mismatches: string[] = [];

    if (finalPhase !== c.expected.finalPhase) {
      mismatches.push(`finalPhase expected '${c.expected.finalPhase}', got '${finalPhase}'`);
    }

    if (finalAcceptanceStatus !== c.expected.acceptanceStatus) {
      mismatches.push(
        `acceptanceStatus expected '${c.expected.acceptanceStatus}', got '${finalAcceptanceStatus}'`
      );
    }

    if (c.expected.minPassedGates !== undefined && passedGates < c.expected.minPassedGates) {
      mismatches.push(`passedGates expected >= ${c.expected.minPassedGates}, got ${passedGates}`);
    }

    if (c.expected.maxRepairs !== undefined && repairCount > c.expected.maxRepairs) {
      mismatches.push(`repairCount expected <= ${c.expected.maxRepairs}, got ${repairCount}`);
    }

    if (c.expected.minPeakParallelism !== undefined) {
      if (metrics.peakParallelism === undefined || metrics.peakParallelism < c.expected.minPeakParallelism) {
        mismatches.push(
          `peakParallelism expected >= ${c.expected.minPeakParallelism}, got ${metrics.peakParallelism}`
        );
      }
    }

    if (c.expected.maxPeakParallelism !== undefined) {
      if (metrics.peakParallelism === undefined || metrics.peakParallelism > c.expected.maxPeakParallelism) {
        mismatches.push(
          `peakParallelism expected <= ${c.expected.maxPeakParallelism}, got ${metrics.peakParallelism}`
        );
      }
    }

    if (c.expected.falseSuccess !== undefined) {
      if (metrics.falseSuccess === undefined || metrics.falseSuccess !== c.expected.falseSuccess) {
        mismatches.push(
          `falseSuccess expected ${c.expected.falseSuccess}, got ${metrics.falseSuccess}`
        );
      }
    }

    if (c.expected.falseFailure !== undefined) {
      if (metrics.falseFailure === undefined || metrics.falseFailure !== c.expected.falseFailure) {
        mismatches.push(
          `falseFailure expected ${c.expected.falseFailure}, got ${metrics.falseFailure}`
        );
      }
    }

    if (c.expected.recoveryExpected !== undefined) {
      const actualRecovery =
        recoveryOutcome !== undefined
          ? (recoveryOutcome === "continue" || recoveryOutcome === "rerun")
          : undefined;
      if (actualRecovery === undefined || actualRecovery !== c.expected.recoveryExpected) {
        mismatches.push(
          `recoveryExpected expected ${c.expected.recoveryExpected}, got ${actualRecovery}`
        );
      }
    }

    if (c.expected.budgetBreached !== undefined) {
      if (budgetBreached === undefined || budgetBreached !== c.expected.budgetBreached) {
        mismatches.push(
          `budgetBreached expected ${c.expected.budgetBreached}, got ${budgetBreached}`
        );
      }
    }

    const allMatched = mismatches.length === 0;
    const mismatchReason = !allMatched
      ? `[BENCHMARK_EXPECTATION_MISMATCH] ${mismatches.join("; ")}`
      : undefined;

    const gateCommandEvidence: BenchmarkCommandEvidence[] = allBundles.flatMap((bundle) =>
      bundle.evidence.map((item) => ({
        phase: "gate" as const,
        command: item.command,
        cwd: path.relative(workspaceDir, item.cwd).replace(/\\/g, "/") || ".",
        timeoutMs: item.timeoutMs,
        termination: item.termination,
        exitCode: item.exitCode,
        stdoutSummary: item.stdoutSummary,
        stderrSummary: item.stderrSummary,
        stdoutSha256: item.stdoutSha256,
        stderrSha256: item.stderrSha256,
        evidenceId: item.evidenceId,
        artifactIds: item.artifactIds,
      }))
    );

    const mandatoryGateIds = new Set(
      config.gates.filter((gate) => gate.mandatory).map((gate) => gate.id)
    );
    const mandatoryGateEvidenceComplete = [...mandatoryGateIds].every((gateId) =>
      allBundles.some((bundle) => {
        const result = bundle.gates.find((gate) => gate.gateId === gateId);
        if (!result?.evidenceId) return false;
        return bundle.evidence.some(
          (item) =>
            item.evidenceId === result.evidenceId &&
            item.runId === runId &&
            item.cycleId === bundle.cycleId &&
            item.gateId === result.gateId &&
            item.operationId === result.operationId
        );
      })
    );
    const acceptanceEvidenceComplete =
      finalAcceptanceStatus === "accepted" &&
      lastBundle !== undefined &&
      lastBundle.verdicts.length > 0 &&
      lastBundle.verdicts.every(
        (verdict) =>
          verdict.status === "accepted" &&
          verdict.evidenceIds.length > 0 &&
          verdict.evidenceIds.every((evidenceId) =>
            lastBundle.evidence.some((item) => item.evidenceId === evidenceId)
          )
      );

    return {
      id: c.id,
      enabled: true,
      status: allMatched ? "passed" : "failed",
      reason: mismatchReason,
      error: mismatchReason,
      expected: c.expected,
      actual: {
        finalPhase,
        acceptanceStatus: finalAcceptanceStatus,
        passedGateCount: passedGates,
        repairCount,
        falseSuccess: metrics.falseSuccess,
        falseFailure: metrics.falseFailure,
        recoveryOutcome,
        budgetBreached,
        executedCommands,
        source: externalContext
          ? { ...externalContext.source, repositoryRoot: "<external-root>" }
          : undefined,
        modifiedFiles: diffEvidence?.modifiedFiles,
        diffFingerprint: diffEvidence?.patchSha256,
        secretFindings: diffEvidence?.secretFindings,
        adapterNative,
        adapterOutcome,
        commandEvidence: [
          ...(externalContext?.setupEvidence ?? []),
          ...gateCommandEvidence,
        ],
        evidenceFacts: {
          runIdentityRecorded: allEvents.some(
            (event) => event.runId === runId && event.type === "run.created"
          ),
          expectedOutcomeRecorded: true,
          mandatoryGateEvidenceComplete,
          acceptanceEvidenceComplete,
        },
      },
      metrics,
    };
  }
}

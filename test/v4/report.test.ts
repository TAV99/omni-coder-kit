import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import {
  computeSemanticHash,
  generateBenchmarkJson,
  generateBenchmarkMarkdown,
  normalizeBenchmarkReport,
  writeBenchmarkArtifacts,
} from "../../src/v4/benchmark/report";
import {
  BenchmarkRunner,
  getGitMetadata,
  type BenchmarkRunReport,
} from "../../src/v4/benchmark/runner";
import { asRunId, asEventId } from "../../src/v4/contracts/ids";
import {
  asGateId,
  asQualityCycleId,
  asQualityEvidenceId,
  asRequirementId,
  type GateDefinition,
} from "../../src/v4/contracts/quality";
import {
  EvidenceBundleStore,
  type EvidenceBundle,
} from "../../src/v4/quality/evidence-bundle-store";
import { GateScheduler } from "../../src/v4/quality/gate-scheduler";
import { GateRunner } from "../../src/v4/quality/gate-runner";
import type { ProcessRunner, ProcessRequest, ProcessResult } from "../../src/v4/process/types";

const sampleReport: BenchmarkRunReport = {
  schemaVersion: 1,
  benchmarkRunId: "bm-test-123",
  manifestHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  configHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  semanticHash: "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0",
  gitMetadata: {
    revision: "abc1234",
    isDirty: false,
  },
  environment: {
    platform: "win32",
    nodeVersion: "v20.0.0",
    liveApproved: false,
  },
  liveApproved: false,
  modelCallCount: 0,
  startedAt: "2026-08-20T10:00:00.000Z",
  completedAt: "2026-08-20T10:00:05.000Z",
  durationMs: 5000,
  totalCases: 2,
  passedCases: 1,
  failedCases: 0,
  skippedCases: 1,
  falseSuccessCount: 0,
  falseFailureCount: 0,
  cases: [
    {
      id: "case-01",
      enabled: true,
      status: "passed",
      expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
      actual: {
        finalPhase: "DOCUMENT",
        acceptanceStatus: "accepted",
        passedGateCount: 2,
        repairCount: 0,
        falseSuccess: false,
        falseFailure: false,
      },
      metrics: {
        schemaVersion: 1,
        runId: asRunId("run-1"),
        actualStatus: "succeeded",
        reportedStatus: "succeeded",
        falseSuccess: false,
        falseFailure: false,
        gateCounts: { passed: 2, failed: 0, skipped: 0, inconclusive: 0 },
        retryCount: 0,
        repairCount: 0,
        resumeCount: 0,
        userInterventionCount: 0,
        wallClockMs: 1200,
        summedGateDurationMs: 2000,
        gateQueueMs: 50,
        peakParallelism: 2,
        measuredSpeedup: 1.67,
        missingMetrics: [],
      },
    },
    {
      id: "case-02",
      enabled: false,
      status: "skipped",
      reason: "Case is disabled",
      expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
      actual: {
        finalPhase: "NONE",
        acceptanceStatus: "none",
        passedGateCount: 0,
        repairCount: 0,
        falseSuccess: false,
        falseFailure: false,
      },
    },
  ],
};

test("stable_gate_order", async () => {
  // R59: Final reports sort gates by declaration order regardless of completion order
  const finishOrder: string[] = [];

  const runner: ProcessRunner = {
    run: async (options: ProcessRequest): Promise<ProcessResult> => {
      const gateId = options.args[1] ?? options.command;
      // Delay inversely so gate-gamma finishes first (10ms), gate-beta second (30ms), gate-alpha last (60ms)
      const delayMs = gateId === "gate-gamma" ? 10 : gateId === "gate-beta" ? 30 : 60;
      await new Promise((r) => setTimeout(r, delayMs));
      finishOrder.push(gateId);
      return {
        stdout: `PASS ${gateId}`,
        stderr: "",
        durationMs: delayMs,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const scheduler = new GateScheduler({ maxParallelGates: 4 });

  const gates: GateDefinition[] = [
    {
      id: asGateId("gate-alpha"),
      command: "npm",
      args: ["test", "gate-alpha"],
      cwd: ".",
      timeoutMs: 5000,
      mandatory: true,
      requirementIds: [asRequirementId("R1")],
      dependsOn: [],
      sideEffect: "read-only",
      retrySafe: true,
    },
    {
      id: asGateId("gate-beta"),
      command: "npm",
      args: ["test", "gate-beta"],
      cwd: ".",
      timeoutMs: 5000,
      mandatory: true,
      requirementIds: [asRequirementId("R2")],
      dependsOn: [],
      sideEffect: "read-only",
      retrySafe: true,
    },
    {
      id: asGateId("gate-gamma"),
      command: "npm",
      args: ["test", "gate-gamma"],
      cwd: ".",
      timeoutMs: 5000,
      mandatory: true,
      requirementIds: [asRequirementId("R3")],
      dependsOn: [],
      sideEffect: "read-only",
      retrySafe: true,
    },
  ];

  const schedRes = await scheduler.schedule(gates, {
    runId: asRunId("run-order-test"),
    cycleId: asQualityCycleId("cycle-1"),
    projectRoot: ".",
    runner,
    gateRunner,
  });

  // Verify that completion order was strictly reversed
  assert.deepEqual(finishOrder, ["gate-gamma", "gate-beta", "gate-alpha"]);

  // Verify that scheduler output results keys are in declaration order
  assert.deepEqual(Array.from(schedRes.results.keys()), [
    asGateId("gate-alpha"),
    asGateId("gate-beta"),
    asGateId("gate-gamma"),
  ]);

  const store = new EvidenceBundleStore({ projectRoot: "." });
  const bundle: EvidenceBundle = {
    schemaVersion: 1,
    runId: asRunId("run-order-test"),
    cycleId: asQualityCycleId("cycle-1"),
    phase: "VERIFY",
    configHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    requirementsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    generatedAt: "2026-08-20T10:00:00.000Z",
    gates: Array.from(schedRes.results.values()),
    evidence: Array.from(schedRes.evidences.values()),
    verdicts: [
      {
        requirementId: asRequirementId("R1"),
        status: "accepted",
        evidenceIds: [schedRes.results.get(asGateId("gate-alpha"))!.evidenceId!],
        rationale: "Alpha passed",
      },
      {
        requirementId: asRequirementId("R2"),
        status: "accepted",
        evidenceIds: [schedRes.results.get(asGateId("gate-beta"))!.evidenceId!],
        rationale: "Beta passed",
      },
      {
        requirementId: asRequirementId("R3"),
        status: "accepted",
        evidenceIds: [schedRes.results.get(asGateId("gate-gamma"))!.evidenceId!],
        rationale: "Gamma passed",
      },
    ],
    repairHistory: [],
    decision: { kind: "advance", to: "ACCEPT" },
    routeIntent: {
      kind: "advance",
      from: "VERIFY",
      to: "ACCEPT",
      causedByEventId: asEventId("ev-1"),
    },
  };

  // Verify that bundle.gates array maintains declaration order
  assert.deepEqual(bundle.gates.map((g) => g.gateId), [
    asGateId("gate-alpha"),
    asGateId("gate-beta"),
    asGateId("gate-gamma"),
  ]);

  // Verify that rendered markdown report table lists gates in declaration order
  const md = store.exportSummaryMarkdown(bundle);
  const alphaIdx = md.indexOf("gate-alpha");
  const betaIdx = md.indexOf("gate-beta");
  const gammaIdx = md.indexOf("gate-gamma");

  assert.ok(alphaIdx !== -1 && betaIdx !== -1 && gammaIdx !== -1);
  assert.ok(alphaIdx < betaIdx, "gate-alpha must appear before gate-beta in report");
  assert.ok(betaIdx < gammaIdx, "gate-beta must appear before gate-gamma in report");
});

test("json_and_markdown_outputs", async () => {
  // R76: Benchmark reports produce both JSON and Markdown outputs
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-rep-test-"));
  const { jsonPath, mdPath } = await writeBenchmarkArtifacts(sampleReport, tmpDir);

  const jsonContent = await fs.readFile(jsonPath, "utf-8");
  const mdContent = await fs.readFile(mdPath, "utf-8");

  assert.ok(jsonContent.includes("bm-test-123"));
  assert.ok(mdContent.includes("Omni v4 Benchmark Verification Report"));
  assert.ok(mdContent.includes("## Summary"));
  assert.ok(mdContent.includes("## Case Breakdown"));
  assert.ok(mdContent.includes("## Efficiency & Concurrency Summary"));
  assert.ok(mdContent.includes("## Audit & Environment"));
  assert.ok(mdContent.includes("Git Revision"));

  // Verify Markdown was rendered from persisted JSON by comparing with generateBenchmarkMarkdown(JSON.parse(jsonContent))
  const parsedFromJson: BenchmarkRunReport = JSON.parse(jsonContent);
  const expectedMd = generateBenchmarkMarkdown(parsedFromJson);
  assert.equal(mdContent, expectedMd, "Markdown must be strictly derived from persisted JSON");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("reproducible_from_inputs", () => {
  // R77: Report outputs are deterministic and reproducible from identical input data
  const json1 = generateBenchmarkJson(sampleReport);
  const json2 = generateBenchmarkJson(sampleReport);
  assert.equal(json1, json2);

  const md1 = generateBenchmarkMarkdown(sampleReport);
  const md2 = generateBenchmarkMarkdown(sampleReport);
  assert.equal(md1, md2);

  // Normalization semantic projection: two reports with divergent Windows vs POSIX temp paths,
  // timestamps, run IDs, and durations produce byte-identical normalized reports and semantic hashes.
  const volatileReportA: BenchmarkRunReport = {
    ...sampleReport,
    benchmarkRunId: "bm-run-111",
    startedAt: "2026-08-20T11:22:33.444Z",
    completedAt: "2026-08-20T11:22:38.444Z",
    durationMs: 9876,
    cases: [
      {
        ...sampleReport.cases[0]!,
        reason: "Failed in C:/Users/ADMINI~1/AppData/Local/Temp/omni-ws-1111/step.ts",
        error: "Error at C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\omni-ws-1111\\run.log",
        actual: {
          ...sampleReport.cases[0]!.actual,
          executedCommands: ["node C:/Users/ADMINI~1/AppData/Local/Temp/omni-ws-1111/index.js"],
        },
        metrics: sampleReport.cases[0]!.metrics
          ? {
              ...sampleReport.cases[0]!.metrics,
              wallClockMs: 1234,
              summedGateDurationMs: 2345,
              measuredSpeedup: 1.9,
            }
          : undefined,
      },
    ],
  };

  const volatileReportB: BenchmarkRunReport = {
    ...sampleReport,
    benchmarkRunId: "bm-run-999",
    startedAt: "2026-08-21T05:10:15.000Z",
    completedAt: "2026-08-21T05:10:20.000Z",
    durationMs: 1234,
    cases: [
      {
        ...sampleReport.cases[0]!,
        reason: "Failed in /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/omni-ws-9999/step.ts",
        error: "Error at /tmp/omni-ws-9999/run.log",
        actual: {
          ...sampleReport.cases[0]!.actual,
          executedCommands: ["node /tmp/omni-ws-9999/index.js"],
        },
        metrics: sampleReport.cases[0]!.metrics
          ? {
              ...sampleReport.cases[0]!.metrics,
              wallClockMs: 9876,
              summedGateDurationMs: 18000,
              measuredSpeedup: 1.82,
            }
          : undefined,
      },
    ],
  };

  const normA = generateBenchmarkJson(normalizeBenchmarkReport(volatileReportA));
  const normB = generateBenchmarkJson(normalizeBenchmarkReport(volatileReportB));
  assert.equal(normA, normB, "Normalized JSON reports with divergent temp paths must be byte-identical");

  const normMdA = generateBenchmarkMarkdown(normalizeBenchmarkReport(volatileReportA));
  const normMdB = generateBenchmarkMarkdown(normalizeBenchmarkReport(volatileReportB));
  assert.equal(normMdA, normMdB, "Normalized Markdown summaries must be byte-identical");

  // Semantic hash calculation using canonical production computeSemanticHash helper
  const hashA = computeSemanticHash(volatileReportA);
  const hashB = computeSemanticHash(volatileReportB);
  assert.equal(hashA, hashB, "Semantic hashes must be identical for logically-equivalent reports across divergent temp paths");

  // Verification that raw duration and temp path changes DO NOT alter the semantic hash
  const volatileReportC: BenchmarkRunReport = {
    ...volatileReportA,
    durationMs: 888888,
    cases: [
      {
        ...volatileReportA.cases[0]!,
        reason: "Failed in /tmp/another-random-temp-path/test.ts",
        metrics: volatileReportA.cases[0]!.metrics
          ? {
              ...volatileReportA.cases[0]!.metrics,
              wallClockMs: 77777,
              summedGateDurationMs: 99999,
            }
          : undefined,
      },
    ],
  };
  assert.equal(
    computeSemanticHash(volatileReportC),
    hashA,
    "Raw duration or temp path changes must not alter the semantic hash"
  );

  // 1. Correctness mutation alters semantic hash
  const mutatedCorrectness: BenchmarkRunReport = {
    ...volatileReportA,
    passedCases: 0,
    failedCases: 1,
  };
  assert.notEqual(
    computeSemanticHash(mutatedCorrectness),
    hashA,
    "Correctness mutation must alter the semantic hash"
  );

  // 2. Concurrency mutation alters semantic hash
  const mutatedConcurrency: BenchmarkRunReport = {
    ...volatileReportA,
    cases: [
      {
        ...volatileReportA.cases[0]!,
        metrics: volatileReportA.cases[0]!.metrics
          ? {
              ...volatileReportA.cases[0]!.metrics,
              peakParallelism: 5, // Mutated parallelism
            }
          : undefined,
      },
    ],
  };
  assert.notEqual(
    computeSemanticHash(mutatedConcurrency),
    hashA,
    "Concurrency mutation must alter the semantic hash"
  );

  // 3. Budget mutation alters semantic hash
  const mutatedBudget: BenchmarkRunReport = {
    ...volatileReportA,
    cases: [
      {
        ...volatileReportA.cases[0]!,
        actual: {
          ...volatileReportA.cases[0]!.actual,
          budgetBreached: true,
        },
      },
    ],
  };
  assert.notEqual(
    computeSemanticHash(mutatedBudget),
    hashA,
    "Budget breach mutation must alter the semantic hash"
  );

  // 4. Recovery mutation alters semantic hash
  const mutatedRecovery: BenchmarkRunReport = {
    ...volatileReportA,
    cases: [
      {
        ...volatileReportA.cases[0]!,
        actual: {
          ...volatileReportA.cases[0]!.actual,
          recoveryOutcome: "continue",
        },
      },
    ],
  };
  assert.notEqual(
    computeSemanticHash(mutatedRecovery),
    hashA,
    "Recovery outcome mutation must alter the semantic hash"
  );

  // 5. Source revision mutation alters semantic hash
  const mutatedRevision: BenchmarkRunReport = {
    ...volatileReportA,
    gitMetadata: {
      revision: "mutated-revision-12345",
      isDirty: false,
    },
  };
  assert.notEqual(
    computeSemanticHash(mutatedRevision),
    hashA,
    "Source revision mutation must alter the semantic hash"
  );

  // 6. Source dirty status mutation alters semantic hash
  const mutatedDirty: BenchmarkRunReport = {
    ...volatileReportA,
    gitMetadata: {
      revision: volatileReportA.gitMetadata.revision,
      isDirty: true,
    },
  };
  assert.notEqual(
    computeSemanticHash(mutatedDirty),
    hashA,
    "Source dirty state mutation must alter the semantic hash"
  );
});

test("runner_reproducible_semantic_hash_twice", async () => {
  // Point 5: Run BenchmarkRunner twice offline on deterministic fixture and assert semantic-output hash equal (semantic equality, not source-tree equality)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-rep-twice-"));
  const bmDir = path.join(tmpDir, "benchmarks", "v4");
  const fixDir = path.join(tmpDir, "benchmarks", "v4", "fixtures", "pass-all");
  await fs.mkdir(bmDir, { recursive: true });
  await fs.mkdir(fixDir, { recursive: true });
  await fs.cp(path.resolve(process.cwd(), "benchmarks/v4/fixtures/pass-all"), fixDir, { recursive: true });

  const manifestData = {
    schemaVersion: 1,
    cases: [
      {
        id: "case-twice-01",
        enabled: true,
        projectKind: "fixture",
        fixturePath: "benchmarks/v4/fixtures/pass-all",
        adapter: "fake",
        liveModelCostOptIn: false,
        expected: {
          finalPhase: "DOCUMENT",
          acceptanceStatus: "accepted",
          minPassedGates: 1,
        },
        tags: ["reproducible"],
      },
    ],
  };

  await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(manifestData, null, 2), "utf-8");

  const runner1 = new BenchmarkRunner({
    repoRoot: tmpDir,
    allowModelCost: false,
  });
  const report1 = await runner1.run();

  const runner2 = new BenchmarkRunner({
    repoRoot: tmpDir,
    allowModelCost: false,
  });
  const report2 = await runner2.run();

  assert.equal(report1.passedCases, 1);
  assert.equal(report2.passedCases, 1);
  assert.equal(report1.failedCases, 0);
  assert.equal(report2.failedCases, 0);
  assert.equal(
    report1.semanticHash,
    report2.semanticHash,
    "Two offline benchmark runs with identical inputs must produce identical semantic-output hashes"
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("git_metadata_read_only_and_unavailable_handling", async () => {
  // 1. Compare production metadata with deterministic read-only git query on real repo
  const actualRev = child_process
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    })
    .trim();
  const actualStatus = child_process
    .execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    })
    .trim();

  const meta = getGitMetadata(process.cwd());
  assert.equal(meta.revision, actualRev, "getGitMetadata must return exact HEAD revision");
  assert.equal(
    meta.isDirty,
    actualStatus.length > 0,
    "getGitMetadata must reflect exact dirty state"
  );

  // 2. Unavailable handling when directory is not a git repository
  const emptyTmp = await fs.mkdtemp(path.join(os.tmpdir(), "omni-no-git-"));
  const noGitMeta = getGitMetadata(emptyTmp);
  assert.deepEqual(
    noGitMeta,
    { revision: null, isDirty: null },
    "Non-git repository must return explicitly null metadata, never fabricated clean"
  );
  await fs.rm(emptyTmp, { recursive: true, force: true });

  // 3. Markdown rendering renders unavailable, DIRTY, and CLEAN truthfully
  const unavailReport: BenchmarkRunReport = {
    ...sampleReport,
    gitMetadata: { revision: null, isDirty: null },
  };
  const mdUnavail = generateBenchmarkMarkdown(unavailReport);
  assert.ok(mdUnavail.includes("| Git Revision | unavailable |"));
  assert.ok(mdUnavail.includes("| Git Dirty | unavailable |"));
  assert.ok(
    mdUnavail.includes("| Source Reproducibility | NOT CLAIMABLE (Git metadata unavailable) |"),
    "Unavailable Git metadata must not imply source-level reproducibility"
  );

  const dirtyReport: BenchmarkRunReport = {
    ...sampleReport,
    gitMetadata: { revision: "abc1234", isDirty: true },
  };
  const mdDirty = generateBenchmarkMarkdown(dirtyReport);
  assert.ok(mdDirty.includes("| Git Revision | `abc1234` |"));
  assert.ok(mdDirty.includes("| Git Dirty | DIRTY |"));
  assert.ok(
    mdDirty.includes("| Source Reproducibility | NOT CLAIMABLE (dirty worktree) |"),
    "A dirty worktree must explicitly disable source-level reproducibility claims"
  );

  const cleanReport: BenchmarkRunReport = {
    ...sampleReport,
    gitMetadata: { revision: "abc1234", isDirty: false },
  };
  const mdClean = generateBenchmarkMarkdown(cleanReport);
  assert.ok(mdClean.includes("| Git Revision | `abc1234` |"));
  assert.ok(mdClean.includes("| Git Dirty | CLEAN |"));
  assert.ok(
    mdClean.includes("| Source Reproducibility | ELIGIBLE (clean Git revision) |"),
    "Only a clean exact Git revision is eligible for a source-level reproducibility claim"
  );

  // 4. Semantic projection preserves source revision and dirty state
  const hashClean = computeSemanticHash(cleanReport);
  const hashDirty = computeSemanticHash(dirtyReport);
  assert.notEqual(
    hashClean,
    hashDirty,
    "Changed dirty state must alter the semantic hash"
  );

  const hashOtherRev = computeSemanticHash({
    ...sampleReport,
    gitMetadata: { revision: "def5678", isDirty: false },
  });
  assert.notEqual(
    hashClean,
    hashOtherRev,
    "Changed revision must alter the semantic hash"
  );
});

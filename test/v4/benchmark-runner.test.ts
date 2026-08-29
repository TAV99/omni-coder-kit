import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  BenchmarkRunner,
  copyDirectoryContained,
  copyFileContained,
} from "../../src/v4/benchmark/runner";
import type { BenchmarkCase, BenchmarkExpectation } from "../../src/v4/benchmark/contracts";
import type { ProcessRunner, ProcessRequest, ProcessResult } from "../../src/v4/process/types";
import { FakeAdapter } from "../../src/v4/testing/fake-adapter";
import type { AgentAdapter, StepRequest } from "../../src/v4/contracts/adapter";

async function snapshotSourceCorpus(repoRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  async function hashFile(relPath: string): Promise<void> {
    const fullPath = path.resolve(repoRoot, relPath);
    try {
      const buf = await fs.readFile(fullPath);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      map.set(relPath.replace(/\\/g, "/"), hash);
    } catch {
      // Optional or non-existent file
    }
  }

  async function scanDir(relDir: string): Promise<void> {
    const fullDir = path.resolve(repoRoot, relDir);
    let entries;
    try {
      entries = await fs.readdir(fullDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "scratch" ||
        entry.name === "reports"
      ) {
        continue;
      }
      const relEntry = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(relEntry);
      } else if (entry.isFile()) {
        await hashFile(relEntry);
      }
    }
  }

  // 1. Single fixed files staged for dogfood
  await hashFile("package.json");
  await hashFile("tsconfig.v4.json");
  await hashFile("scripts/run-v4-tests.cjs");

  // 2. Full source directories
  await scanDir("src");
  await scanDir("compatibility/v4");
  await scanDir("benchmarks/v4/fixtures");
  await scanDir("test/fixtures/v4");

  // 3. Staged test files
  await scanDir("test/v4");

  return map;
}

test("isolated_workspace", async () => {
  // R70: Benchmark cases execute in isolated temporary workspaces
  // (a) Pre-run byte snapshot of the full source corpus (fixtures + self dogfood inputs)
  const preSnapshot = await snapshotSourceCorpus(process.cwd());
  assert.ok(preSnapshot.size > 20, "Source corpus snapshot must contain all relevant source files");

  const runner = new BenchmarkRunner({
    repoRoot: process.cwd(),
    allowModelCost: false,
  });

  const report = await runner.run();
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.totalCases, 17);
  assert.equal(report.skippedCases, 3); // 3 disabled future slots
  assert.equal(report.failedCases, 0);
  assert.equal(report.passedCases, 14); // 14 enabled deterministic cases
  assert.equal(report.falseSuccessCount, 0);
  assert.equal(report.falseFailureCount, 0);

  // Check omni self dogfood case executed in isolation and ran real npm scripts
  const omniCase = report.cases.find((c) => c.id === "case-12-omni-self-dogfood");
  assert.ok(omniCase);
  assert.equal(omniCase.status, "passed");
  assert.equal(omniCase.actual.finalPhase, "DOCUMENT");
  assert.equal(omniCase.actual.acceptanceStatus, "accepted");
  assert.equal(omniCase.actual.passedGateCount >= 3, true);
  assert.ok(omniCase.actual.executedCommands && omniCase.actual.executedCommands.length >= 3);
  assert.ok(omniCase.actual.executedCommands.includes("npm run build:v4"));
  assert.ok(omniCase.actual.executedCommands.includes("npm run typecheck:v4"));
  assert.ok(omniCase.actual.executedCommands.includes("npm run test:v4"));

  // Check case-13-workspace-serialization executed with maxPeakParallelism=1
  const wsCase = report.cases.find((c) => c.id === "case-13-workspace-serialization");
  assert.ok(wsCase);
  assert.equal(wsCase.status, "passed");
  assert.equal(wsCase.actual.finalPhase, "DOCUMENT");
  assert.equal(wsCase.actual.acceptanceStatus, "accepted");
  assert.ok(wsCase.metrics && wsCase.metrics.peakParallelism === 1, "Workspace write gates must serialize to peakParallelism=1");

  // (a) Post-run byte identity assertion: all files in source corpus are byte-identical
  const postSnapshot = await snapshotSourceCorpus(process.cwd());
  assert.equal(postSnapshot.size, preSnapshot.size, "Source corpus file count must remain identical");
  for (const [filePath, preHash] of preSnapshot.entries()) {
    const postHash = postSnapshot.get(filePath);
    assert.equal(postHash, preHash, `Source file '${filePath}' byte hash changed during benchmark run`);
  }

  // (b) Check workspace factory observer, unique temp roots, and owned cleanup on success
  let case12SupportVerified = false;
  const createdDirs: string[] = [];
  const cleanedDirs: string[] = [];
  const observedRunner = new BenchmarkRunner({
    repoRoot: process.cwd(),
    allowModelCost: false,
    workspaceFactory: async (caseId) => {
      const p = await fs.mkdtemp(path.join(os.tmpdir(), `obs-${caseId}-`));
      createdDirs.push(p);
      return {
        path: p,
        cleanup: async () => {
          if (caseId === "case-12-omni-self-dogfood") {
            // Regression check: verify required staged support files exist in workspace and match source bytes
            const checkFiles = [
              "compatibility/v4/hosts.json",
              "test/fixtures/v4/process-fixture.cjs",
              "test/fixtures/v4/hosts/antigravity/success.json",
              "test/fixtures/v4/hosts/claude/success.json",
              "test/fixtures/v4/hosts/codex/success.jsonl",
            ];
            for (const rel of checkFiles) {
              const srcFile = path.resolve(process.cwd(), rel);
              const wsFile = path.join(p, rel);
              assert.ok(syncFs.existsSync(wsFile), `Staged file '${rel}' must exist in case-12 workspace`);
              const srcBytes = await fs.readFile(srcFile);
              const wsBytes = await fs.readFile(wsFile);
              assert.equal(
                Buffer.compare(srcBytes, wsBytes),
                0,
                `Staged file '${rel}' must match source bytes byte-for-byte`
              );
            }
            case12SupportVerified = true;
          }
          cleanedDirs.push(p);
          await fs.rm(p, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  });

  await observedRunner.run();
  assert.ok(createdDirs.length >= 14, "Workspace factory created temp roots for all enabled cases");
  assert.equal(new Set(createdDirs).size, createdDirs.length, "All owned temp roots must be unique");
  assert.equal(cleanedDirs.length, createdDirs.length, "All temp workspaces were cleaned up");
  assert.equal(case12SupportVerified, true, "case-12 support files were verified before cleanup");

  // (c) Cleanup occurs on staging thrown error (forced by workspace pointing to an existing non-directory file)
  let stagingCleanupCalled = false;
  const stagingErrorParent = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-stage-err-"));
  const stagingErrorFileAsDir = path.join(stagingErrorParent, "blocker.txt");
  await fs.writeFile(stagingErrorFileAsDir, "existing non-directory file", "utf-8");

  const stagingErrorRunner = new BenchmarkRunner({
    repoRoot: process.cwd(),
    allowModelCost: false,
    workspaceFactory: async () => {
      return {
        path: stagingErrorFileAsDir,
        cleanup: async () => {
          stagingCleanupCalled = true;
          await fs.rm(stagingErrorParent, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  });

  const stagingErrorReport = await stagingErrorRunner.run();
  assert.ok(stagingErrorReport.failedCases > 0, "Staging error must cause case failure");
  assert.equal(stagingCleanupCalled, true, "Workspace cleanup must be called on staging thrown error");
  assert.equal(syncFs.existsSync(stagingErrorParent), false, "Owned root must be removed after staging error cleanup");

  // (d) Case-level expectation/assertion failure triggers cleanup and removes owned root
  // Note: BenchmarkRunner executes cases synchronously/asynchronously per case without exposing an AbortSignal.
  // Cancellation via abort signal is not supported/exposed by BenchmarkRunner; we test expectation failure cleanup here.
  let expectationCleanupCalled = false;
  const expectationTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-expect-fail-"));
  const mismatchManifestDir = path.join(expectationTmpDir, "benchmarks", "v4");
  const mismatchFixDir = path.join(expectationTmpDir, "benchmarks", "v4", "fixtures", "pass-all");
  await fs.mkdir(mismatchManifestDir, { recursive: true });
  await fs.mkdir(mismatchFixDir, { recursive: true });
  await fs.cp(path.resolve(process.cwd(), "benchmarks/v4/fixtures/pass-all"), mismatchFixDir, { recursive: true });

  const mismatchManifest = {
    schemaVersion: 1,
    cases: [
      {
        id: "case-mismatch-expect",
        enabled: true,
        projectKind: "fixture",
        fixturePath: "benchmarks/v4/fixtures/pass-all",
        adapter: "fake",
        liveModelCostOptIn: false,
        expected: {
          finalPhase: "IMPOSSIBLE_PHASE",
          acceptanceStatus: "accepted",
        },
        tags: ["test"],
      },
    ],
  };
  await fs.writeFile(path.join(mismatchManifestDir, "manifest.json"), JSON.stringify(mismatchManifest, null, 2), "utf-8");

  const ownedExpectationDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-owned-expect-"));
  const expectationRunner = new BenchmarkRunner({
    repoRoot: expectationTmpDir,
    allowModelCost: false,
    workspaceFactory: async () => {
      return {
        path: ownedExpectationDir,
        cleanup: async () => {
          expectationCleanupCalled = true;
          await fs.rm(ownedExpectationDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  });

  const expectReport = await expectationRunner.run();
  assert.equal(expectReport.cases[0]?.status, "failed");
  assert.ok(expectReport.cases[0]?.reason?.includes("BENCHMARK_EXPECTATION_MISMATCH"));
  assert.equal(expectationCleanupCalled, true, "Cleanup must be called on case expectation failure");
  assert.equal(syncFs.existsSync(ownedExpectationDir), false, "Owned workspace root must be removed after expectation failure");
  await fs.rm(expectationTmpDir, { recursive: true, force: true });

  // Adversarial 1: Source symlink escaping source root
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-iso-test-"));
  const escapeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-outside-"));
  try {
    const bmDir = path.join(tmpDir, "benchmarks", "v4");
    const fixDir = path.join(tmpDir, "benchmarks", "v4", "fixtures", "escape-symlink");
    await fs.mkdir(bmDir, { recursive: true });
    await fs.mkdir(fixDir, { recursive: true });

    let symlinkCreated = false;
    try {
      const outsideFile = path.join(escapeDir, "secret.txt");
      await fs.writeFile(outsideFile, "secret-data", "utf-8");
      await fs.symlink(outsideFile, path.join(fixDir, "escaped-link.txt"));
      symlinkCreated = true;
    } catch {
      // If OS permissions prohibit symlink creation, continue
    }

    if (symlinkCreated) {
      const manifestData = {
        schemaVersion: 1,
        cases: [
          {
            id: "case-escape",
            enabled: true,
            projectKind: "fixture",
            fixturePath: "benchmarks/v4/fixtures/escape-symlink",
            adapter: "fake",
            liveModelCostOptIn: false,
            expected: {
              finalPhase: "DOCUMENT",
              acceptanceStatus: "accepted",
            },
            tags: ["security"],
          },
        ],
      };

      await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(manifestData, null, 2), "utf-8");

      const isoRunner = new BenchmarkRunner({
        repoRoot: tmpDir,
        allowModelCost: false,
      });

      const isoReport = await isoRunner.run();
      assert.equal(isoReport.cases[0]?.status, "failed");
      assert.ok(
        isoReport.cases[0]?.error?.includes("BENCHMARK_WORKSPACE_UNSAFE") ||
          isoReport.cases[0]?.error?.includes("escapes") ||
          isoReport.cases[0]?.error?.includes("outside")
      );
    }

    // Adversarial 2: copyDirectoryContained rejects destination escape
    await assert.rejects(
      () => copyDirectoryContained(fixDir, escapeDir, tmpDir, tmpDir),
      (err: unknown) =>
        err instanceof Error &&
        (err.message.includes("escapes destination root") || err.message.includes("BENCHMARK_WORKSPACE_UNSAFE"))
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(escapeDir, { recursive: true, force: true });
  }
});

test("fake_adapter_default", async () => {
  // R71: Deterministic benchmarks use a fake adapter by default and consume no model quota
  const runner = new BenchmarkRunner({
    repoRoot: process.cwd(),
    allowModelCost: false,
  });

  const report = await runner.run();
  assert.equal(report.modelCallCount, 0, "Deterministic benchmarks must have 0 model calls");
  assert.equal(report.liveApproved, false, "Live execution must be disabled by default");

  // Every enabled case must use fake adapter and consume zero cost
  for (const c of report.cases) {
    if (c.enabled) {
      assert.equal(c.metrics?.usage?.costUsd, undefined, "Deterministic case must not incur cost");
    }
  }
});

test("live_host_requires_opt_in", async () => {
  // R72: Live-host benchmark execution requires an explicit opt-in flag AND OMNI_V4_ALLOW_MODEL_COST=1
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-live-test-"));
  const bmDir = path.join(tmpDir, "benchmarks", "v4");
  await fs.mkdir(bmDir, { recursive: true });

  const fixDir = path.join(tmpDir, "benchmarks", "v4", "fixtures", "pass-all");
  await fs.mkdir(fixDir, { recursive: true });
  await fs.cp(path.resolve(process.cwd(), "benchmarks/v4/fixtures/pass-all"), fixDir, { recursive: true });

  let processInvocationCount = 0;
  const mockProcessRunner: ProcessRunner = {
    run: async (_options: ProcessRequest): Promise<ProcessResult> => {
      processInvocationCount++;
      return {
        stdout: "PASS",
        stderr: "",
        durationMs: 10,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  let adapterFactoryCount = 0;
  let adapterExecuteCount = 0;
  const spyAdapterFactory = (_c: unknown) => {
    adapterFactoryCount++;
    return {
      id: "spy-adapter",
      probe: async () => ({
        available: true,
        adapterId: "spy-adapter",
        capabilities: [],
        diagnostics: [],
      }),
      execute: async (request: StepRequest) => {
        adapterExecuteCount++;
        return {
          status: "succeeded" as const,
          executionId: request.operationId,
          summary: "live executed",
          artifacts: [],
          evidence: [],
        };
      },
      cancel: async () => {},
    };
  };

  const createManifest = async (liveOptIn: boolean) => {
    const data = {
      schemaVersion: 1,
      cases: [
        {
          id: "case-live-01",
          enabled: true,
          projectKind: "fixture",
          fixturePath: "benchmarks/v4/fixtures/pass-all",
          adapter: "claude", // Non-fake adapter requested
          liveModelCostOptIn: liveOptIn,
          expected: {
            finalPhase: "DOCUMENT",
            acceptanceStatus: "accepted",
          },
          tags: ["live"],
        },
      ],
    };
    await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(data, null, 2), "utf-8");
  };

  const originalEnv = process.env.OMNI_V4_ALLOW_MODEL_COST;

  try {
    // Case A: manifest liveModelCostOptIn=false, env="1" -> Skipped, 0 invocations
    process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
    await createManifest(false);
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerA = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportA = await runnerA.run();
    assert.equal(reportA.cases[0]?.status, "skipped");
    assert.ok(reportA.cases[0]?.reason?.includes("LIVE_BENCHMARK_NOT_APPROVED"));
    assert.ok(reportA.cases[0]?.reason?.includes("manifest liveModelCostOptIn=true"));
    assert.ok(reportA.cases[0]?.reason?.includes("process.env.OMNI_V4_ALLOW_MODEL_COST=1"));
    assert.ok(reportA.cases[0]?.reason?.includes("runner allowModelCost=true"));
    assert.equal(processInvocationCount, 0, "Case A must make 0 process invocations");
    assert.equal(adapterFactoryCount, 0, "Case A must make 0 adapter factory invocations");
    assert.equal(adapterExecuteCount, 0, "Case A must make 0 adapter execute invocations");

    // Case B: manifest liveModelCostOptIn=true, env=undefined -> Skipped, 0 invocations
    delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    await createManifest(true);
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerB = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportB = await runnerB.run();
    assert.equal(reportB.cases[0]?.status, "skipped");
    assert.ok(reportB.cases[0]?.reason?.includes("LIVE_BENCHMARK_NOT_APPROVED"));
    assert.ok(reportB.cases[0]?.reason?.includes("manifest liveModelCostOptIn=true"));
    assert.ok(reportB.cases[0]?.reason?.includes("process.env.OMNI_V4_ALLOW_MODEL_COST=1"));
    assert.ok(reportB.cases[0]?.reason?.includes("runner allowModelCost=true"));
    assert.equal(processInvocationCount, 0, "Case B must make 0 process invocations");
    assert.equal(adapterFactoryCount, 0, "Case B must make 0 adapter factory invocations");
    assert.equal(adapterExecuteCount, 0, "Case B must make 0 adapter execute invocations");

    // Case C: manifest liveModelCostOptIn=true, env="true" (not "1") -> Skipped, 0 invocations
    process.env.OMNI_V4_ALLOW_MODEL_COST = "true";
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerC = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportC = await runnerC.run();
    assert.equal(reportC.cases[0]?.status, "skipped");
    assert.ok(reportC.cases[0]?.reason?.includes("LIVE_BENCHMARK_NOT_APPROVED"));
    assert.equal(processInvocationCount, 0, "Case C must make 0 process invocations");
    assert.equal(adapterFactoryCount, 0, "Case C must make 0 adapter factory invocations");
    assert.equal(adapterExecuteCount, 0, "Case C must make 0 adapter execute invocations");

    // Case D: manifest liveModelCostOptIn=true, env="01" -> Skipped, 0 invocations
    process.env.OMNI_V4_ALLOW_MODEL_COST = "01";
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerD = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportD = await runnerD.run();
    assert.equal(reportD.cases[0]?.status, "skipped");
    assert.ok(reportD.cases[0]?.reason?.includes("LIVE_BENCHMARK_NOT_APPROVED"));
    assert.equal(processInvocationCount, 0, "Case D must make 0 process invocations");
    assert.equal(adapterFactoryCount, 0, "Case D must make 0 adapter factory invocations");
    assert.equal(adapterExecuteCount, 0, "Case D must make 0 adapter execute invocations");

    // Case D2: manifest liveModelCostOptIn=true AND env="1" BUT allowModelCost=false -> Skipped, 0 invocations
    process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerD2 = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: false, // Disallowed runner flag
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportD2 = await runnerD2.run();
    assert.equal(reportD2.cases[0]?.status, "skipped");
    assert.ok(reportD2.cases[0]?.reason?.includes("LIVE_BENCHMARK_NOT_APPROVED"));
    assert.equal(processInvocationCount, 0, "Case D2 must make 0 process invocations");
    assert.equal(adapterFactoryCount, 0, "Case D2 must make 0 adapter factory invocations");
    assert.equal(adapterExecuteCount, 0, "Case D2 must make 0 adapter execute invocations");

    // Case E: manifest liveModelCostOptIn=true AND env="1" AND allowModelCost=true -> Authorized to run with injected spy
    process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerE = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportE = await runnerE.run();
    assert.equal(reportE.cases[0]?.status, "passed");
    assert.ok(processInvocationCount > 0, "Case E must execute gates when fully authorized");
    assert.equal(adapterFactoryCount, 1, "Case E must invoke adapter factory exactly once");
    assert.equal(adapterExecuteCount, 1, "Case E must invoke adapter execute exactly once");
    assert.equal(reportE.modelCallCount, 1, "Case E modelCallCount must reflect 1 actual execute call");

    // Case F: Authorized live case in production WITHOUT adapterFactory must FAIL CLOSED with 0 execute and 0 process calls
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerF = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
    });
    const reportF = await runnerF.run();
    assert.equal(reportF.cases[0]?.status, "failed");
    assert.equal(adapterExecuteCount, 0, "Case F must make 0 adapter execute invocations");
    assert.equal(processInvocationCount, 0, "Case F must make 0 process invocations before fail-closed");
    assert.equal(reportF.modelCallCount, 0, "Case F modelCallCount must be 0");
    assert.ok(
      reportF.cases[0]?.error?.includes("LIVE_ADAPTER_UNAVAILABLE") ||
        reportF.cases[0]?.reason?.includes("LIVE_ADAPTER_UNAVAILABLE"),
      "Must fail closed when live adapter is unavailable"
    );

    // Case G: Authorized live case + successful execute + case expectation failure -> execute=1, report=1, status=failed
    process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
    const failExpectationManifest = {
      schemaVersion: 1,
      cases: [
        {
          id: "case-live-fail-expectation",
          enabled: true,
          projectKind: "fixture",
          fixturePath: "benchmarks/v4/fixtures/pass-all",
          adapter: "claude",
          liveModelCostOptIn: true,
          expected: {
            finalPhase: "IMPOSSIBLE_PHASE", // Deliberately failing expectation
            acceptanceStatus: "accepted",
          },
          tags: ["live"],
        },
      ],
    };
    await fs.writeFile(
      path.join(bmDir, "manifest.json"),
      JSON.stringify(failExpectationManifest, null, 2),
      "utf-8"
    );
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerG = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: spyAdapterFactory,
    });
    const reportG = await runnerG.run();
    assert.equal(reportG.cases[0]?.status, "failed");
    assert.equal(adapterExecuteCount, 1, "Case G execute must be invoked once");
    assert.equal(reportG.modelCallCount, 1, "Case G modelCallCount must be 1 even on expectation failure");

    // Case H: Authorized live case where adapter.execute throws -> execute attempt=1, report=1, 0 gates executed
    const throwingAdapterFactory = (c: BenchmarkCase): AgentAdapter => ({
      id: "throwing-adapter",
      probe: async () => ({
        available: true,
        adapterId: "throwing-adapter",
        capabilities: [],
        diagnostics: [],
      }),
      execute: async () => {
        adapterExecuteCount++;
        throw new Error("Simulated adapter network drop after invocation");
      },
      cancel: async () => {},
    });
    await createManifest(true);
    processInvocationCount = 0;
    adapterFactoryCount = 0;
    adapterExecuteCount = 0;
    const runnerH = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: true,
      processRunner: mockProcessRunner,
      adapterFactory: throwingAdapterFactory,
    });
    const reportH = await runnerH.run();
    assert.equal(reportH.cases[0]?.status, "failed");
    assert.equal(adapterExecuteCount, 1, "Case H execute attempt must be recorded");
    assert.equal(reportH.modelCallCount, 1, "Case H modelCallCount must be 1 even when execute throws");
    assert.equal(processInvocationCount, 0, "Case H must execute 0 gates when execute throws before quality cycle");
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMNI_V4_ALLOW_MODEL_COST = originalEnv;
    } else {
      delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("correctness_precedes_efficiency", async () => {
  // R78: Correctness regressions fail the P3 gate even when wall-clock or token metrics improve
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-regress-"));
  const bmDir = path.join(tmpDir, "benchmarks", "v4");
  const fixDir = path.join(tmpDir, "benchmarks", "v4", "fixtures", "regress");
  const sdlcDir = path.join(fixDir, ".omni", "sdlc");
  const v4Dir = path.join(fixDir, ".omni", "v4");

  await fs.mkdir(bmDir, { recursive: true });
  await fs.mkdir(sdlcDir, { recursive: true });
  await fs.mkdir(v4Dir, { recursive: true });

  // Stage a case where duration is ultra-fast (1ms), but gate exits with code 1 (injected correctness regression)
  await fs.writeFile(
    path.join(sdlcDir, "requirements.md"),
    "# Regress Requirements\n- [ ] R1 | Mandatory Gate | test: node -e process.exit(1)\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(v4Dir, "quality.json"),
    JSON.stringify({
      schemaVersion: 1,
      requirementsPath: ".omni/sdlc/requirements.md",
      gates: [
        {
          id: "fast-failing-gate",
          command: "node",
          args: ["-e", "process.exit(1)"],
          cwd: ".",
          timeoutMs: 5000,
          mandatory: true,
          requirementIds: ["R1"],
          dependsOn: [],
          sideEffect: "read-only",
          retrySafe: true,
        },
      ],
    }),
    "utf-8"
  );

  // Table-driven expectation validation: mismatched expectations fail closed with BENCHMARK_EXPECTATION_MISMATCH
  const testCases: Array<{
    name: string;
    expectation: BenchmarkExpectation;
    expectedPass: boolean;
  }> = [
    {
      name: "mismatched_final_phase",
      expectation: { finalPhase: "DOCUMENT", acceptanceStatus: "rejected" },
      expectedPass: false,
    },
    {
      name: "mismatched_acceptance_status",
      expectation: { finalPhase: "FIX", acceptanceStatus: "accepted" },
      expectedPass: false,
    },
    {
      name: "mismatched_min_passed_gates",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", minPassedGates: 1 },
      expectedPass: false,
    },
    {
      name: "mismatched_max_repairs",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", maxRepairs: 0 },
      expectedPass: false,
    },
    {
      name: "mismatched_min_peak_parallelism",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", minPeakParallelism: 5 },
      expectedPass: false,
    },
    {
      name: "mismatched_max_peak_parallelism",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", maxPeakParallelism: 0 },
      expectedPass: false,
    },
    {
      name: "mismatched_false_success_expectation",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", falseSuccess: true },
      expectedPass: false,
    },
    {
      name: "mismatched_false_failure_expectation",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", falseFailure: true },
      expectedPass: false,
    },
    {
      name: "mismatched_recovery_expected_true_on_unrecovered_case",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", recoveryExpected: true },
      expectedPass: false,
    },
    {
      name: "mismatched_recovery_expected_false_on_unmeasured_case",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", recoveryExpected: false },
      expectedPass: false, // Must fail closed when recovery was never evaluated/unmeasured
    },
    {
      name: "mismatched_budget_breached_true_on_unbreached_case",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", budgetBreached: true },
      expectedPass: false,
    },
    {
      name: "mismatched_budget_breached_false_on_unmeasured_case",
      expectation: { finalPhase: "FIX", acceptanceStatus: "rejected", budgetBreached: false },
      expectedPass: false, // Must fail closed when budget was never evaluated/unmeasured
    },
    {
      name: "correctly_matching_expectations",
      expectation: {
        finalPhase: "FIX",
        acceptanceStatus: "rejected",
        minPassedGates: 0,
        maxRepairs: 1,
        falseSuccess: false,
        falseFailure: false,
      },
      expectedPass: true,
    },
  ];

  for (const tc of testCases) {
    const manifestData = {
      schemaVersion: 1,
      cases: [
        {
          id: `case-${tc.name}`,
          enabled: true,
          projectKind: "fixture",
          fixturePath: "benchmarks/v4/fixtures/regress",
          adapter: "fake",
          liveModelCostOptIn: false,
          expected: tc.expectation,
          tags: ["table-driven"],
        },
      ],
    };

    await fs.writeFile(
      path.join(bmDir, "manifest.json"),
      JSON.stringify(manifestData, null, 2),
      "utf-8"
    );

    const runner = new BenchmarkRunner({
      repoRoot: tmpDir,
      allowModelCost: false,
    });

    const report = await runner.run();
    const res = report.cases[0]!;

    if (tc.expectedPass) {
      assert.equal(res.status, "passed", `Case '${tc.name}' expected to pass`);
      assert.equal(report.passedCases, 1);
      assert.equal(report.failedCases, 0);
    } else {
      assert.equal(res.status, "failed", `Case '${tc.name}' expected to fail`);
      assert.equal(report.failedCases, 1, `Overall P3 benchmark report must fail when case fails`);
      assert.equal(report.passedCases, 0);
      assert.ok(
        res.reason?.includes("BENCHMARK_EXPECTATION_MISMATCH"),
        `Mismatched case '${tc.name}' must report BENCHMARK_EXPECTATION_MISMATCH reason`
      );
      assert.equal(report.modelCallCount, 0);
      assert.ok(report.durationMs < 5000, "Duration was fast, but correctness failure caught");
    }
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("copy_file_contained_security_and_byte_proofs", async () => {
  // R70: copyFileContained must verify exact SHA-256 byte identity and parent/child containment
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-copy-proofs-"));
  const srcRoot = path.join(rootDir, "src-root");
  const destRoot = path.join(rootDir, "dest-root");
  const outsideDir = path.join(rootDir, "outside");

  await fs.mkdir(srcRoot, { recursive: true });
  await fs.mkdir(destRoot, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  const testFileSrc = path.join(srcRoot, "valid-file.txt");
  const testFileContent = "test byte contents: 1234567890\n";
  await fs.writeFile(testFileSrc, testFileContent, "utf-8");

  const testFileDest = path.join(destRoot, "sub", "valid-file.txt");

  // 1. Valid copy succeeds and preserves exact byte identity & source immutability
  await copyFileContained(testFileSrc, testFileDest, srcRoot, destRoot);
  const destContent = await fs.readFile(testFileDest, "utf-8");
  assert.equal(destContent, testFileContent);
  const postSrcContent = await fs.readFile(testFileSrc, "utf-8");
  assert.equal(postSrcContent, testFileContent, "Source file must remain unchanged after copy");

  // 2. Escape attempts fail-closed
  const outsideSrc = path.join(outsideDir, "outside.txt");
  await fs.writeFile(outsideSrc, "outside", "utf-8");
  await assert.rejects(
    async () => {
      await copyFileContained(outsideSrc, testFileDest, srcRoot, destRoot);
    },
    { message: /escapes source root/ }
  );

  const outsideDest = path.join(outsideDir, "outside-dest.txt");
  await assert.rejects(
    async () => {
      await copyFileContained(testFileSrc, outsideDest, srcRoot, destRoot);
    },
    { message: /escapes destination root/ }
  );

  await fs.rm(rootDir, { recursive: true, force: true });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadBenchmarkManifest } from "../../src/v4/benchmark/manifest";
import { BenchmarkRunner, type BenchmarkCaseResult } from "../../src/v4/benchmark/runner";
import { QualityError } from "../../src/v4/quality/errors";

test("strict_versioned_manifest", async () => {
  // R69: Benchmark manifests are strict and versioned
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-test-"));
  const bmDir = path.join(tmpDir, "benchmarks", "v4");
  await fs.mkdir(bmDir, { recursive: true });

  const manifestData = {
    schemaVersion: 1,
    cases: [
      {
        id: "case-01",
        enabled: true,
        applicability: "applicable",
        projectKind: "fixture",
        fixturePath: "benchmarks/v4/fixtures/pass-all",
        adapter: "fake",
        expected: {
          finalPhase: "DOCUMENT",
          acceptanceStatus: "accepted",
        },
        tags: ["smoke", "pass"],
      },
    ],
  };

  await fs.writeFile(
    path.join(bmDir, "manifest.json"),
    JSON.stringify(manifestData, null, 2),
    "utf-8"
  );

  const loaded = await loadBenchmarkManifest(tmpDir);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.cases[0]?.id, "case-01");
  assert.equal(loaded.cases[0]?.applicability, "applicable");

  // Adversarial: Invalid schemaVersion rejected
  const badVersion = { ...manifestData, schemaVersion: 2 };
  await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(badVersion), "utf-8");
  await assert.rejects(
    () => loadBenchmarkManifest(tmpDir),
    (err: unknown) => err instanceof QualityError && err.code === "BENCHMARK_MANIFEST_INVALID"
  );

  // Adversarial: Extra unexpected property rejected by strict schema
  const extraProp = { ...manifestData, unknownField: true };
  await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(extraProp), "utf-8");
  await assert.rejects(
    () => loadBenchmarkManifest(tmpDir),
    (err: unknown) => err instanceof QualityError && err.code === "BENCHMARK_MANIFEST_INVALID"
  );

  // Adversarial: Duplicate case IDs rejected
  const dupData = {
    schemaVersion: 1,
    cases: [
      {
        id: "case-01",
        enabled: true,
        applicability: "applicable",
        projectKind: "fixture",
        adapter: "fake",
        expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
        tags: [],
      },
      {
        id: "case-01",
        enabled: true,
        applicability: "applicable",
        projectKind: "fixture",
        adapter: "fake",
        expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
        tags: [],
      },
    ],
  };
  await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(dupData), "utf-8");
  await assert.rejects(
    () => loadBenchmarkManifest(tmpDir),
    (err: unknown) => err instanceof QualityError && err.code === "BENCHMARK_MANIFEST_INVALID"
  );

  // Adversarial: Path escape in fixturePath rejected
  const escapeData = {
    schemaVersion: 1,
    cases: [
      {
        id: "case-02",
        enabled: true,
        applicability: "applicable",
        projectKind: "fixture",
        fixturePath: "../../escape/path",
        adapter: "fake",
        expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
        tags: [],
      },
    ],
  };
  await fs.writeFile(path.join(bmDir, "manifest.json"), JSON.stringify(escapeData), "utf-8");
  await assert.rejects(
    () => loadBenchmarkManifest(tmpDir),
    (err: unknown) => err instanceof QualityError && err.code === "BENCHMARK_MANIFEST_INVALID"
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("representative_case_count", async () => {
  // R73: The benchmark suite contains 10 to 15 enabled deterministic cases covering approved scenarios (excluding disabled future slots)
  const loaded = await loadBenchmarkManifest(process.cwd());
  assert.equal(loaded.schemaVersion, 1);

  const enabledCases = loaded.cases.filter((c) => c.enabled);
  const disabledCases = loaded.cases.filter((c) => !c.enabled);

  assert.ok(
    enabledCases.length >= 10 && enabledCases.length <= 15,
    `Expected 10-15 enabled cases, got ${enabledCases.length}`
  );
  assert.equal(disabledCases.length, 3, "Expected exactly 3 disabled future slots");

  // Verify real implementation expectations across cases (not merely string tags)
  const allScenarios = new Set(enabledCases.map((c) => c.scenario ?? "standard"));
  assert.ok(allScenarios.has("repair-progress"), "Must include repair progress scenario");
  assert.ok(allScenarios.has("repair-no-progress"), "Must include repair loop scenario");
  assert.ok(allScenarios.has("crash-resume"), "Must include crash recovery scenario");

  const hasConcurrencyLock = enabledCases.some(
    (c) => c.expected.minPeakParallelism !== undefined && c.expected.minPeakParallelism >= 2
  );
  assert.ok(hasConcurrencyLock, "Must include concurrency gate expectation");

  const hasBudgetExpectation = enabledCases.some(
    (c) => c.expected.budgetBreached === true
  );
  assert.ok(hasBudgetExpectation, "Must include budget breach expectation");

  const hasFalseSuccessExpectation = enabledCases.some(
    (c) => c.expected.falseSuccess === false
  );
  assert.ok(hasFalseSuccessExpectation, "Must include false success prevention expectation");
});

test("omni_self_case", async () => {
  // R74: The benchmark manifest includes an enabled Omni self-dogfood case
  const loaded = await loadBenchmarkManifest(process.cwd());
  const omniCase = loaded.cases.find((c) => c.projectKind === "omni");
  assert.ok(omniCase, "Omni self-dogfood case must exist");
  assert.equal(omniCase.enabled, true, "Omni self-dogfood case must be enabled");
  assert.equal(omniCase.adapter, "fake", "Omni self-dogfood case must use fake adapter by default");
  assert.equal(omniCase.expected.finalPhase, "DOCUMENT");
  assert.equal(omniCase.expected.acceptanceStatus, "accepted");

  // Prove that enabled self case executes actual isolated npm scripts (build:v4, typecheck:v4, test:v4)
  const runner = new BenchmarkRunner({
    repoRoot: process.cwd(),
    allowModelCost: false,
  });

  const report = await runner.run();
  const executedOmni = report.cases.find((c) => c.id === omniCase.id);
  assert.ok(executedOmni, "Executed omni case must exist in report");
  assert.equal(executedOmni.status, "passed");
  assert.equal(executedOmni.actual.finalPhase, "DOCUMENT");
  assert.equal(executedOmni.actual.acceptanceStatus, "accepted");
  assert.ok(executedOmni.actual.passedGateCount >= 3);
  assert.ok(executedOmni.actual.executedCommands && executedOmni.actual.executedCommands.length >= 3);
  assert.ok(executedOmni.actual.executedCommands.includes("npm run build:v4"));
  assert.ok(executedOmni.actual.executedCommands.includes("npm run typecheck:v4"));
  assert.ok(executedOmni.actual.executedCommands.includes("npm run test:v4"));
});

test("future_real_repo_slots", async () => {
  // R75: The benchmark manifest includes disabled slots for JavaScript/full-stack, non-JavaScript, and unusual-test-config repositories
  const loaded = await loadBenchmarkManifest(process.cwd());
  const jsSlot = loaded.cases.find((c) => c.projectKind === "javascript");
  const nonJsSlot = loaded.cases.find((c) => c.projectKind === "non-javascript");
  const unusualSlot = loaded.cases.find((c) => c.projectKind === "unusual-tests");

  assert.ok(jsSlot, "JavaScript future slot must exist in manifest");
  assert.equal(jsSlot.enabled, false, "JavaScript slot must be disabled");
  assert.ok(jsSlot.repositoryPath, "JavaScript slot must declare repositoryPath");
  assert.ok(jsSlot.baselineNotes, "JavaScript slot must declare baseline notes");
  assert.ok(jsSlot.gateMapping && Object.keys(jsSlot.gateMapping).length > 0);
  assert.ok(jsSlot.activationChecklist && jsSlot.activationChecklist.length > 0);

  assert.ok(nonJsSlot, "Non-JavaScript future slot must exist in manifest");
  assert.equal(nonJsSlot.enabled, false, "Non-JavaScript slot must be disabled");
  assert.ok(nonJsSlot.repositoryPath, "Non-JavaScript slot must declare repositoryPath");
  assert.ok(nonJsSlot.baselineNotes, "Non-JavaScript slot must declare baseline notes");
  assert.ok(nonJsSlot.gateMapping && Object.keys(nonJsSlot.gateMapping).length > 0);
  assert.ok(nonJsSlot.activationChecklist && nonJsSlot.activationChecklist.length > 0);

  assert.ok(unusualSlot, "Unusual tests future slot must exist in manifest");
  assert.equal(unusualSlot.enabled, false, "Unusual tests slot must be disabled");
  assert.ok(unusualSlot.repositoryPath, "Unusual tests slot must declare repositoryPath");
  assert.ok(unusualSlot.baselineNotes, "Unusual tests slot must declare baseline notes");
  assert.ok(unusualSlot.gateMapping && Object.keys(unusualSlot.gateMapping).length > 0);
  assert.ok(unusualSlot.activationChecklist && unusualSlot.activationChecklist.length > 0);

  for (const slot of [nonJsSlot, unusualSlot]) {
    assert.equal(slot.adapter, "codex");
    assert.equal(slot.liveModelCostOptIn, true);
    assert.equal(slot.liveTask?.sideEffect, "workspace-write");
    assert.ok(slot.liveTask?.requirements.length);
    assert.ok(slot.liveTask?.gates.length);
    assert.equal(slot.liveTask?.requiredDependencyPolicy, "clean-install");
  }
  assert.equal(unusualSlot.liveTask?.outputSummaryBytes, 8192);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkRunner } from "../../src/v4/benchmark/runner";
import { loadBenchmarkManifest } from "../../src/v4/benchmark/manifest";

async function createFixtureManifest(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-runtime-activation-"));
  const fixture = path.join(root, "benchmarks", "v4", "fixtures", "pass-all");
  await fs.mkdir(fixture, { recursive: true });
  await fs.cp(path.resolve("benchmarks/v4/fixtures/pass-all"), fixture, { recursive: true });
  await fs.writeFile(
    path.join(root, "benchmarks", "v4", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      cases: [
        {
          id: "disabled-fixture",
          enabled: false,
          applicability: "applicable",
          projectKind: "fixture",
          fixturePath: "benchmarks/v4/fixtures/pass-all",
          adapter: "fake",
          liveModelCostOptIn: false,
          expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
          tags: ["activation-test"],
        },
      ],
    }),
    "utf-8"
  );
  return root;
}

test("runtime_activation: exact disabled case executes only when requested", async () => {
  const root = await createFixtureManifest();
  const defaultReport = await new BenchmarkRunner({ repoRoot: root }).run();
  assert.equal(defaultReport.skippedCases, 1);
  assert.equal(defaultReport.modelCallCount, 0);

  const activatedReport = await new BenchmarkRunner({
    repoRoot: root,
    activateCaseIds: ["disabled-fixture"],
  }).run();
  assert.equal(activatedReport.passedCases, 1);
  assert.equal(activatedReport.skippedCases, 0);
  assert.equal(activatedReport.cases[0]?.enabled, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("runtime_activation: rejects duplicate or unknown activation IDs before staging", async () => {
  const root = await createFixtureManifest();
  await assert.rejects(
    new BenchmarkRunner({
      repoRoot: root,
      activateCaseIds: ["disabled-fixture", "disabled-fixture"],
    }).run(),
    /BENCHMARK_ACTIVATION_INVALID/
  );
  await assert.rejects(
    new BenchmarkRunner({ repoRoot: root, activateCaseIds: ["similar-case"] }).run(),
    /BENCHMARK_ACTIVATION_INVALID/
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("runtime_activation: model-cost approval does not activate disabled manifest cases", async () => {
  const root = await createFixtureManifest();
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  try {
    const report = await new BenchmarkRunner({ repoRoot: root, allowModelCost: true }).run();
    assert.equal(report.skippedCases, 1);
    assert.equal(report.passedCases, 0);
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime_activation: checked-in case 15 remains disabled with an explicit Codex contract", async () => {
  const manifest = await loadBenchmarkManifest(process.cwd());
  const external = manifest.cases.find((item) => item.id === "case-15-external-js-slot");
  assert.ok(external);
  assert.equal(external.enabled, false);
  assert.equal(external.adapter, "codex");
  assert.equal(external.liveModelCostOptIn, true);
  assert.equal(external.liveTask?.sideEffect, "workspace-write");
  assert.deepEqual(external.liveTask?.allowedPaths, [
    "package.json",
    "src/components/WaitlistForm.test.tsx",
  ]);
});

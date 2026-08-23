import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkRunner } from "../../src/v4/benchmark/runner";
import { writeBenchmarkArtifacts } from "../../src/v4/benchmark/report";

test("benchmark_e2e_full_suite: executes all manifest cases and emits reproducible artifacts", async () => {
  const tmpOut = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bm-e2e-"));

  try {
    const runner = new BenchmarkRunner({
      repoRoot: process.cwd(),
      allowModelCost: false,
      outputDir: tmpOut,
    });

    const report = await runner.run();
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.totalCases, 17);
    assert.equal(report.passedCases, 14);
    assert.equal(report.failedCases, 0);
    assert.equal(report.skippedCases, 3);
    assert.equal(report.falseSuccessCount, 0);
    assert.equal(report.falseFailureCount, 0);

    const { jsonPath, mdPath } = await writeBenchmarkArtifacts(report, tmpOut);

    const jsonStat = await fs.stat(jsonPath);
    const mdStat = await fs.stat(mdPath);

    assert.ok(jsonStat.size > 0);
    assert.ok(mdStat.size > 0);

    const rawJson = await fs.readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(rawJson);
    assert.equal(parsed.passedCases, 14);

    const rawMd = await fs.readFile(mdPath, "utf-8");
    assert.ok(rawMd.includes("Omni v4 Benchmark Verification Report"));
    assert.ok(rawMd.includes("case-12-omni-self-dogfood"));
    assert.ok(rawMd.includes("case-13-workspace-serialization"));
    assert.ok(rawMd.includes("case-14-budget-mandatory-breach"));
  } finally {
    await fs.rm(tmpOut, { recursive: true, force: true });
  }
});

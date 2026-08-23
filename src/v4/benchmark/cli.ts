import path from "node:path";
import { BenchmarkRunner } from "./runner";
import { writeBenchmarkArtifacts } from "./report";

async function main() {
  const repoRoot = process.cwd();
  const allowModelCost = process.env.OMNI_V4_ALLOW_MODEL_COST === "1";
  const runner = new BenchmarkRunner({
    repoRoot,
    allowModelCost,
  });

  const report = await runner.run();
  const outputDir = path.join(repoRoot, ".omni", "v4", "benchmarks", report.benchmarkRunId);
  const { jsonPath, mdPath } = await writeBenchmarkArtifacts(report, outputDir);

  console.log(`[Omni v4 Benchmark] Completed in ${report.durationMs}ms`);
  console.log(`  Total: ${report.totalCases}`);
  console.log(`  Passed: ${report.passedCases}`);
  console.log(`  Failed: ${report.failedCases}`);
  console.log(`  Skipped: ${report.skippedCases}`);
  console.log(`  Reports written:`);
  console.log(`    JSON: ${jsonPath}`);
  console.log(`    Markdown: ${mdPath}`);

  if (report.failedCases > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[Omni v4 Benchmark] Fatal error:`, err);
  process.exit(1);
});

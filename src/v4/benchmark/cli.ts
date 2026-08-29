import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkRunner, type BenchmarkRunReport } from "./runner";
import { writeBenchmarkArtifacts } from "./report";
import { NodeProcessRunner } from "../process/node-process-runner";
import { createAdapter } from "../adapters/registry";

export interface BenchmarkCliArgs {
  readonly activateCaseIds: readonly string[];
  readonly externalBindingPath?: string | undefined;
  readonly allowModelCost: boolean;
}

function cliError(message: string): Error {
  return new Error(`[BENCHMARK_CLI_INVALID] ${message}`);
}

export function parseBenchmarkCliArgs(argv: readonly string[]): BenchmarkCliArgs {
  const activateCaseIds: string[] = [];
  let externalBindingPath: string | undefined;
  let allowModelCost = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--activate") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw cliError("--activate requires a case ID");
      activateCaseIds.push(value);
    } else if (arg === "--bindings") {
      const value = argv[++index];
      if (!value || value.startsWith("--") || externalBindingPath) {
        throw cliError("--bindings requires exactly one path");
      }
      externalBindingPath = value;
    } else if (arg === "--allow-model-cost") {
      if (allowModelCost) throw cliError("--allow-model-cost may be supplied only once");
      allowModelCost = true;
    } else {
      throw cliError(`Unknown argument '${arg}'`);
    }
  }

  if (new Set(activateCaseIds).size !== activateCaseIds.length) {
    throw cliError("Activation case IDs must be unique");
  }
  if (activateCaseIds.length > 0 && !externalBindingPath) {
    throw cliError("--bindings is required when --activate is used");
  }
  if (externalBindingPath && activateCaseIds.length === 0) {
    throw cliError("--bindings requires at least one --activate case");
  }

  return {
    activateCaseIds,
    ...(externalBindingPath ? { externalBindingPath } : {}),
    allowModelCost,
  };
}

export async function runBenchmarkCli(
  argv: readonly string[] = process.argv.slice(2),
  repoRoot: string = process.cwd()
): Promise<BenchmarkRunReport> {
  const parsed = parseBenchmarkCliArgs(argv);
  const processRunner = new NodeProcessRunner();
  const adapterTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omni-benchmark-adapter-"));
  try {
    const runner = new BenchmarkRunner({
      repoRoot,
      allowModelCost: parsed.allowModelCost,
      activateCaseIds: parsed.activateCaseIds,
      ...(parsed.externalBindingPath ? { externalBindingPath: parsed.externalBindingPath } : {}),
      processRunner,
      adapterFactory: async (caseDef) => {
        if (caseDef.adapter !== "codex") {
          throw new Error("[LIVE_ADAPTER_UNAVAILABLE] CLI qualification supports Codex only");
        }
        return createAdapter(
          {
            runner: processRunner,
            projectDir: repoRoot,
            compatibilityManifestPath: path.join(repoRoot, "compatibility", "v4", "hosts.json"),
            allowExperimental: false,
          },
          { hostId: "codex", tempDir: adapterTempRoot }
        );
      },
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

    if (report.failedCases > 0) process.exitCode = 1;
    return report;
  } finally {
    await fs.rm(adapterTempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (require.main === module) {
  runBenchmarkCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Omni v4 Benchmark] Fatal error: ${message}`);
    process.exitCode = 1;
  });
}

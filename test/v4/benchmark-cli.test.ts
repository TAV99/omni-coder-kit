import test from "node:test";
import assert from "node:assert/strict";
import { parseBenchmarkCliArgs } from "../../src/v4/benchmark/cli";

test("benchmark_cli: parses exact activation, binding, and model-cost flags", () => {
  assert.deepEqual(
    parseBenchmarkCliArgs([
      "--activate",
      "case-15-external-js-slot",
      "--bindings",
      ".omni/v4/benchmarks/external-bindings.json",
      "--allow-model-cost",
    ]),
    {
      activateCaseIds: ["case-15-external-js-slot"],
      externalBindingPath: ".omni/v4/benchmarks/external-bindings.json",
      allowModelCost: true,
    }
  );
  assert.deepEqual(parseBenchmarkCliArgs([]), {
    activateCaseIds: [],
    allowModelCost: false,
  });
});

test("benchmark_cli: rejects unknown, missing, duplicate, and incomplete flags", () => {
  assert.throws(() => parseBenchmarkCliArgs(["--unknown"]), /BENCHMARK_CLI_INVALID/);
  assert.throws(() => parseBenchmarkCliArgs(["--activate"]), /BENCHMARK_CLI_INVALID/);
  assert.throws(
    () => parseBenchmarkCliArgs(["--activate", "case-15"]),
    /BENCHMARK_CLI_INVALID/
  );
  assert.throws(
    () => parseBenchmarkCliArgs(["--bindings", "bindings.json"]),
    /BENCHMARK_CLI_INVALID/
  );
  assert.throws(
    () => parseBenchmarkCliArgs(["--allow-model-cost", "--allow-model-cost"]),
    /BENCHMARK_CLI_INVALID/
  );
});

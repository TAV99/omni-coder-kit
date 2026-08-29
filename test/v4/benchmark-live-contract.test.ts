import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkRunner } from "../../src/v4/benchmark/runner";
import type { StepRequest } from "../../src/v4/contracts/adapter";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";

async function createLiveFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-live-contract-"));
  const fixture = path.join(root, "benchmarks", "v4", "fixtures", "pass-all");
  await fs.mkdir(fixture, { recursive: true });
  await fs.cp(path.resolve("benchmarks/v4/fixtures/pass-all"), fixture, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    cases: [
      {
        id: "live-contract-case",
        enabled: true,
        applicability: "applicable",
        projectKind: "fixture",
        fixturePath: "benchmarks/v4/fixtures/pass-all",
        adapter: "codex",
        liveModelCostOptIn: true,
        expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted" },
        tags: ["live-contract"],
        liveTask: {
          prompt: "Make npm test deterministic.",
          allowedPaths: ["package.json"],
          requiredCapabilities: ["workspace.read", "workspace.write", "structured-output"],
          sideEffect: "workspace-write",
          timeoutMs: 180000,
          setupCommands: [],
          requirements: [{ id: "R1", text: "Pass the deterministic gate" }],
          gates: [
            {
              id: "gate-live",
              command: "node",
              args: ["--version"],
              cwd: ".",
              timeoutMs: 1000,
              mandatory: true,
              requirementIds: ["R1"],
              dependsOn: [],
              sideEffect: "read-only",
              retrySafe: true,
            },
          ],
        },
      },
    ],
  };
  await fs.writeFile(
    path.join(root, "benchmarks", "v4", "manifest.json"),
    JSON.stringify(manifest),
    "utf-8"
  );
  return root;
}

function passingProcessRunner(counter: { value: number }): ProcessRunner {
  return {
    run: async (_request: ProcessRequest): Promise<ProcessResult> => {
      counter.value++;
      return {
        stdout: "PASS",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };
}

test("live_adapter_outcome: malformed or non-success output fails before gates", async () => {
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  const outcomes: readonly unknown[] = [
    { status: "succeeded" },
    {
      status: "failed",
      executionId: "live-exec-live-contract-case",
      failure: { code: "NOPE", message: "failed", retryable: false, signature: "sig" },
    },
    {
      status: "blocked",
      executionId: "live-exec-live-contract-case",
      reason: "blocked",
      requiredAction: "none",
    },
    {
      status: "cancelled",
      executionId: "live-exec-live-contract-case",
      reason: "cancelled",
    },
    {
      status: "succeeded",
      executionId: "wrong-operation",
      summary: "wrong correlation",
      artifacts: [],
      evidence: [],
    },
  ];

  try {
    for (const outcome of outcomes) {
      const root = await createLiveFixture();
      const calls = { value: 0 };
      const report = await new BenchmarkRunner({
        repoRoot: root,
        allowModelCost: true,
        processRunner: passingProcessRunner(calls),
        adapterFactory: () => ({
          id: "codex",
          probe: async () => ({
            available: true,
            adapterId: "codex",
            capabilities: ["workspace.read", "workspace.write", "structured-output"],
            diagnostics: [],
          }),
          execute: async () => outcome,
          cancel: async () => {},
        }),
      }).run();
      assert.equal(report.failedCases, 1);
      assert.equal(calls.value, 0, "independent gates must not execute after invalid adapter output");
      assert.match(
        report.cases[0]?.error ?? "",
        /BENCHMARK_ADAPTER_(RESULT_INVALID|NOT_SUCCEEDED|EXECUTION_MISMATCH)/
      );
      if ((outcome as { status?: string }).status === "failed") {
        assert.deepEqual(report.cases[0]?.actual.adapterOutcome, {
          status: "failed",
          failureCode: "NOPE",
          failureSignature: "sig",
        });
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
  }
});

test("live_adapter_outcome: external request uses the declared workspace-write contract", async () => {
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  const root = await createLiveFixture();
  const calls = { value: 0 };
  let captured: StepRequest | undefined;
  try {
    const report = await new BenchmarkRunner({
      repoRoot: root,
      allowModelCost: true,
      processRunner: passingProcessRunner(calls),
      adapterFactory: () => ({
        id: "codex",
        probe: async () => ({
          available: true,
          adapterId: "codex",
          capabilities: ["workspace.read", "workspace.write", "structured-output"],
          diagnostics: [],
        }),
        execute: async (request) => {
          captured = request;
          return {
            status: "succeeded" as const,
            executionId: request.operationId,
            summary: "executed",
            artifacts: [],
            evidence: [],
          };
        },
        cancel: async () => {},
      }),
    }).run();

    assert.equal(report.passedCases, 1);
    assert.ok(calls.value > 0);
    assert.equal(captured?.prompt, "Make npm test deterministic.");
    assert.equal(captured?.sideEffect, "workspace-write");
    assert.equal(captured?.timeoutMs, 180000);
    assert.deepEqual(captured?.requiredCapabilities, [
      "workspace.read",
      "workspace.write",
      "structured-output",
    ]);
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live_adapter_outcome: missing required probe capability fails before execute", async () => {
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  const root = await createLiveFixture();
  let executeCalls = 0;
  try {
    const report = await new BenchmarkRunner({
      repoRoot: root,
      allowModelCost: true,
      processRunner: passingProcessRunner({ value: 0 }),
      adapterFactory: () => ({
        id: "codex",
        probe: async () => ({
          available: true,
          adapterId: "codex",
          capabilities: ["workspace.read"],
          diagnostics: [],
        }),
        execute: async () => {
          executeCalls++;
          throw new Error("must not execute");
        },
        cancel: async () => {},
      }),
    }).run();
    assert.equal(report.failedCases, 1);
    assert.equal(report.modelCallCount, 0);
    assert.equal(executeCalls, 0);
    assert.match(report.cases[0]?.error ?? "", /LIVE_ADAPTER_CAPABILITY_MISSING/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

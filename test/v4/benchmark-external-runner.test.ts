import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BenchmarkRunner } from "../../src/v4/benchmark/runner";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
    shell: false,
  }).trim();
}

async function createExternalHarness(): Promise<{
  controlRoot: string;
  sourceRoot: string;
  revision: string;
  bindingPath: string;
}> {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omni-runner-source-"));
  git(sourceRoot, ["init"]);
  git(sourceRoot, ["config", "user.name", "Omni Test"]);
  git(sourceRoot, ["config", "user.email", "omni-test@example.invalid"]);
  await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  await fs.writeFile(path.join(sourceRoot, "src", "test.ts"), "export {};\n");
  git(sourceRoot, ["add", "."]);
  git(sourceRoot, ["commit", "-m", "baseline"]);
  const revision = git(sourceRoot, ["rev-parse", "HEAD"]);

  const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omni-runner-control-"));
  const benchmarkDir = path.join(controlRoot, "benchmarks", "v4");
  await fs.mkdir(benchmarkDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    cases: [
      {
        id: "external-js",
        enabled: false,
        projectKind: "javascript",
        repositoryPath: "external/placeholder",
        adapter: "codex",
        liveModelCostOptIn: true,
        expected: { finalPhase: "DOCUMENT", acceptanceStatus: "accepted", minPassedGates: 1 },
        tags: ["external"],
        liveTask: {
          prompt: "Make npm test deterministic.",
          allowedPaths: ["package.json"],
          requiredCapabilities: ["workspace.read", "workspace.write", "structured-output"],
          sideEffect: "workspace-write",
          timeoutMs: 180000,
          setupCommands: [{ program: "npm", args: ["ci"], cwd: ".", timeoutMs: 1000 }],
          requirements: [{ id: "EXT-1", text: "The external test gate passes" }],
          gates: [
            {
              id: "external-test",
              command: "npm",
              args: ["test"],
              cwd: ".",
              timeoutMs: 1000,
              mandatory: true,
              requirementIds: ["EXT-1"],
              dependsOn: [],
              sideEffect: "read-only",
              retrySafe: true,
            },
          ],
        },
      },
    ],
  };
  await fs.writeFile(path.join(benchmarkDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
  const bindingPath = path.join(controlRoot, "external-bindings.json");
  await fs.writeFile(
    bindingPath,
    JSON.stringify({
      schemaVersion: 1,
      cases: {
        "external-js": {
          repositoryRoot: sourceRoot,
          revision,
          dependencyPolicy: "clean-install",
          toolchain: { node: process.version },
        },
      },
    }),
    "utf-8"
  );
  return { controlRoot, sourceRoot, revision, bindingPath };
}

function processRunner(counter: { value: number }): ProcessRunner {
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

test("external_diff: runner stages binding, requires mutation, and records evidence", async () => {
  const harness = await createExternalHarness();
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  const calls = { value: 0 };
  try {
    const report = await new BenchmarkRunner({
      repoRoot: harness.controlRoot,
      activateCaseIds: ["external-js"],
      externalBindingPath: harness.bindingPath,
      allowModelCost: true,
      processRunner: processRunner(calls),
      adapterFactory: () => ({
        id: "codex",
        probe: async () => ({
          available: true,
          adapterId: "codex",
          capabilities: ["workspace.read", "workspace.write", "structured-output"],
          version: "0.150.1",
          diagnostics: [],
        }),
        execute: async (request) => {
          await fs.writeFile(
            path.join(request.workspaceDir, "package.json"),
            '{"scripts":{"test":"vitest run"}}\n'
          );
          return {
            status: "succeeded" as const,
            executionId: request.operationId,
            summary: "updated package script",
            artifacts: [],
            evidence: [],
            native: { sessionId: "session-external", model: "codex" },
          };
        },
        cancel: async () => {},
      }),
    }).run();

    assert.equal(report.passedCases, 1);
    assert.ok(calls.value >= 2, "setup and independent gate must both execute");
    assert.equal(report.cases[0]?.actual.source?.revision, harness.revision);
    assert.deepEqual(report.cases[0]?.actual.modifiedFiles, ["package.json"]);
    assert.match(report.cases[0]?.actual.diffFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.equal(report.cases[0]?.actual.adapterNative?.sessionId, "session-external");
    assert.equal(report.cases[0]?.actual.adapterNative?.cliVersion, "0.150.1");
    const commandEvidence = report.cases[0]?.actual.commandEvidence ?? [];
    assert.deepEqual(commandEvidence[0]?.command, ["npm", "ci"]);
    assert.equal(commandEvidence[0]?.phase, "setup");
    assert.equal(commandEvidence[0]?.termination, "exited");
    assert.equal(commandEvidence[0]?.exitCode, 0);
    assert.equal(commandEvidence[0]?.stdoutSummary, "PASS");
    assert.match(commandEvidence[0]?.stdoutSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.ok(commandEvidence.slice(1).length >= 1);
    for (const gateEvidence of commandEvidence.slice(1)) {
      assert.equal(gateEvidence.phase, "gate");
      assert.deepEqual(gateEvidence.command, ["npm", "test"]);
      assert.equal(gateEvidence.termination, "exited");
      assert.equal(gateEvidence.exitCode, 0);
      assert.equal(gateEvidence.stdoutSummary, "PASS");
      assert.ok(gateEvidence.evidenceId);
    }
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(harness.controlRoot, { recursive: true, force: true });
    await fs.rm(harness.sourceRoot, { recursive: true, force: true });
  }
});

test("external_diff: adapter success without required mutation fails before gates", async () => {
  const harness = await createExternalHarness();
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  const calls = { value: 0 };
  try {
    const report = await new BenchmarkRunner({
      repoRoot: harness.controlRoot,
      activateCaseIds: ["external-js"],
      externalBindingPath: harness.bindingPath,
      allowModelCost: true,
      processRunner: processRunner(calls),
      adapterFactory: () => ({
        id: "codex",
        probe: async () => ({
          available: true,
          adapterId: "codex",
          capabilities: ["workspace.read", "workspace.write", "structured-output"],
          diagnostics: [],
        }),
        execute: async (request) => ({
          status: "succeeded" as const,
          executionId: request.operationId,
          summary: "claimed success without mutation",
          artifacts: [],
          evidence: [],
        }),
        cancel: async () => {},
      }),
    }).run();
    assert.equal(report.failedCases, 1);
    assert.equal(calls.value, 1, "only setup may run before the missing-mutation failure");
    assert.match(report.cases[0]?.error ?? "", /BENCHMARK_EXTERNAL_MUTATION_REQUIRED/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(harness.controlRoot, { recursive: true, force: true });
    await fs.rm(harness.sourceRoot, { recursive: true, force: true });
  }
});

for (const protectedMutation of [".omni/v4/quality.json", ".env"] as const) {
  test(`external_diff: adapter mutation of protected path ${protectedMutation} fails before gates`, async () => {
    const harness = await createExternalHarness();
    const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
    process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
    const calls = { value: 0 };
    try {
      const report = await new BenchmarkRunner({
        repoRoot: harness.controlRoot,
        activateCaseIds: ["external-js"],
        externalBindingPath: harness.bindingPath,
        allowModelCost: true,
        processRunner: processRunner(calls),
        adapterFactory: () => ({
          id: "codex",
          probe: async () => ({
            available: true,
            adapterId: "codex",
            capabilities: ["workspace.read", "workspace.write", "structured-output"],
            diagnostics: [],
          }),
          execute: async (request) => {
            await fs.writeFile(
              path.join(request.workspaceDir, "package.json"),
              '{"scripts":{"test":"vitest run"}}\n'
            );
            const protectedPath = path.join(request.workspaceDir, ...protectedMutation.split("/"));
            await fs.mkdir(path.dirname(protectedPath), { recursive: true });
            await fs.writeFile(
              protectedPath,
              protectedMutation === ".env"
                ? "API_TOKEN=this-value-must-never-appear-in-errors\n"
                : '{"gates":[]}\n'
            );
            return {
              status: "succeeded" as const,
              executionId: request.operationId,
              summary: "mutated protected control path",
              artifacts: [],
              evidence: [],
            };
          },
          cancel: async () => {},
        }),
      }).run();

      assert.equal(report.failedCases, 1);
      assert.equal(calls.value, 1, "only setup may run before protected mutation rejection");
      assert.match(report.cases[0]?.error ?? "", /BENCHMARK_EXTERNAL_DIFF_SCOPE/);
      assert.doesNotMatch(
        report.cases[0]?.error ?? "",
        /this-value-must-never-appear-in-errors/
      );
    } finally {
      if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
      else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
      await fs.rm(harness.controlRoot, { recursive: true, force: true });
      await fs.rm(harness.sourceRoot, { recursive: true, force: true });
    }
  });
}

test("external_setup: failed setup retains pinned source and typed failure evidence", async () => {
  const harness = await createExternalHarness();
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  try {
    const report = await new BenchmarkRunner({
      repoRoot: harness.controlRoot,
      activateCaseIds: ["external-js"],
      externalBindingPath: harness.bindingPath,
      allowModelCost: true,
      processRunner: {
        run: async () => ({
          stdout: "setup summary",
          stderr: "setup failed",
          durationMs: 1,
          termination: "exited" as const,
          exitCode: 7,
          signal: null,
        }),
      },
      adapterFactory: () => {
        throw new Error("adapter must not be created after setup failure");
      },
    }).run();

    assert.equal(report.failedCases, 1);
    assert.equal(report.cases[0]?.actual.source?.revision, harness.revision);
    assert.deepEqual(report.cases[0]?.actual.commandEvidence?.[0]?.command, ["npm", "ci"]);
    assert.equal(report.cases[0]?.actual.commandEvidence?.[0]?.exitCode, 7);
    assert.equal(report.cases[0]?.actual.commandEvidence?.[0]?.stderrSummary, "setup failed");
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(harness.controlRoot, { recursive: true, force: true });
    await fs.rm(harness.sourceRoot, { recursive: true, force: true });
  }
});

test("external_diff: failed adapter cannot hide a protected mutation", async () => {
  const harness = await createExternalHarness();
  const previous = process.env.OMNI_V4_ALLOW_MODEL_COST;
  process.env.OMNI_V4_ALLOW_MODEL_COST = "1";
  const calls = { value: 0 };
  try {
    const report = await new BenchmarkRunner({
      repoRoot: harness.controlRoot,
      activateCaseIds: ["external-js"],
      externalBindingPath: harness.bindingPath,
      allowModelCost: true,
      processRunner: processRunner(calls),
      adapterFactory: () => ({
        id: "codex",
        probe: async () => ({
          available: true,
          adapterId: "codex",
          capabilities: ["workspace.read", "workspace.write", "structured-output"],
          diagnostics: [],
        }),
        execute: async (request) => {
          await fs.writeFile(path.join(request.workspaceDir, ".env"), "API_TOKEN=hidden-value-123456\n");
          return {
            status: "failed" as const,
            executionId: request.operationId,
            failure: {
              code: "FAILED_AFTER_WRITE",
              message: "failed after mutation",
              retryable: false,
              signature: "failed-after-write",
            },
            native: {
              processEvidence: {
                command: ["codex", "exec", "--cd", "<workspace>"],
                timeoutMs: 180000,
                termination: "exited" as const,
                exitCode: 1,
                stdoutSummary: "",
                stderrSummary: "failed",
                stdoutSha256: "0".repeat(64),
                stderrSha256: "1".repeat(64),
              },
            },
          };
        },
        cancel: async () => {},
      }),
    }).run();
    assert.equal(report.failedCases, 1);
    assert.equal(calls.value, 1, "only setup may run");
    assert.match(report.cases[0]?.error ?? "", /BENCHMARK_EXTERNAL_DIFF_SCOPE/);
    assert.doesNotMatch(report.cases[0]?.error ?? "", /hidden-value-123456/);
    assert.ok(report.cases[0]?.actual.modifiedFiles?.includes(".env"));
    assert.match(report.cases[0]?.actual.diffFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.equal(report.cases[0]?.actual.falseFailureClassified, false);
    assert.equal(report.cases[0]?.actual.adapterNative?.processEvidence?.exitCode, 1);
  } finally {
    if (previous === undefined) delete process.env.OMNI_V4_ALLOW_MODEL_COST;
    else process.env.OMNI_V4_ALLOW_MODEL_COST = previous;
    await fs.rm(harness.controlRoot, { recursive: true, force: true });
    await fs.rm(harness.sourceRoot, { recursive: true, force: true });
  }
});

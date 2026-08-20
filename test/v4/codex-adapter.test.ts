import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../../src/v4/adapters/codex/adapter";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";
import { runAdapterContractSuite } from "../../src/v4/testing/adapter-contract";

const manifestPath = path.resolve(__dirname, "../../compatibility/v4/hosts.json");

test("codex-adapter: probe, execute lifecycle, and result correlation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  const workspaceDir = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  const runner: ProcessRunner = {
    async run(req: ProcessRequest): Promise<ProcessResult> {
      if (req.args.includes("--version")) {
        return {
          stdout: "codex 0.147.0",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      }
      if (req.args.includes("exec") && req.args.includes("--help")) {
        return {
          stdout:
            "Usage: codex exec [--json] [--strict-config] [--ignore-user-config] [--output-schema] [--output-last-message] [--sandbox] [--approve-for-me] [--cd]",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      }

      // Simulation of codex exec run: write output-last-message file
      const resultPathIndex = req.args.indexOf("--output-last-message") + 1;
      const resultPath = req.args[resultPathIndex];
      const validResult = {
        status: "succeeded",
        executionId: "op-test-1",
        summary: "Execution succeeded",
        artifacts: [],
        evidence: [],
      };
      if (resultPath) {
        await fs.writeFile(resultPath, JSON.stringify(validResult), "utf-8");
      }

      return {
        stdout:
          '{"type":"thread.started","thread_id":"thread-123"}\n{"type":"turn.completed","usage":{"total_tokens":10}}\n',
        stderr: "",
        durationMs: 25,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const adapter = new CodexAdapter({
    runner,
    projectDir: workspaceDir,
    compatibilityManifestPath: manifestPath,
    tempDir,
  });

  const probe = await adapter.probe();
  assert.equal(probe.adapterId, "codex");
  assert.equal(probe.available, true);
  assert.ok(probe.capabilities.includes("workspace.write"));

  const stepReq: StepRequest = {
    runId: asRunId("run-1"),
    stepId: asStepId("step-1"),
    phase: "EXECUTE",
    operationId: "op-test-1",
    workspaceDir,
    prompt: "do work",
    requiredCapabilities: ["workspace.read", "workspace.write"],
    sideEffect: "workspace-write",
    timeoutMs: 5000,
  };

  const outcome = (await adapter.execute(stepReq, {
    signal: new AbortController().signal,
    elevatedPermissions: false,
  })) as any;

  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.executionId, "op-test-1");
  assert.equal(outcome.native?.sessionId, "thread-123");

  await fs.rm(tempDir, { recursive: true, force: true });
});

// Run shared contract suite on Codex
runAdapterContractSuite(
  "codex",
  async (runner) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-contract-"));
    return new CodexAdapter({
      runner,
      projectDir: tempDir,
      compatibilityManifestPath: manifestPath,
      tempDir,
    });
  },
  { elevatedFlag: "--dangerously-bypass-approvals-and-sandbox" }
);

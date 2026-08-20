import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AntigravityAdapter } from "../../src/v4/adapters/antigravity/adapter";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";
import { runAdapterContractSuite } from "../../src/v4/testing/adapter-contract";

const manifestPath = path.resolve(__dirname, "../../compatibility/v4/hosts.json");

test("antigravity-adapter: probe, execute lifecycle, and result correlation", async () => {
  const runner: ProcessRunner = {
    async run(req: ProcessRequest): Promise<ProcessResult> {
      if (req.args.includes("--version")) {
        return {
          stdout: "agy 1.1.13",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      }
      if (req.args.includes("--help")) {
        return {
          stdout:
            "Usage: agy [--print] [--output-format] [--json-schema] [--mode] [--sandbox] [--add-dir] [--print-timeout]",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      }

      // Simulation of agy output
      const successEnvelope = {
        type: "result",
        status: "success",
        structured_output: {
          status: "succeeded",
          executionId: "op-agy-1",
          summary: "Antigravity finished work",
          artifacts: [],
          evidence: [],
        },
        session_id: "agy-session-123",
        usage: { total_tokens: 50 },
      };

      return {
        stdout: JSON.stringify(successEnvelope),
        stderr: "",
        durationMs: 25,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const adapter = new AntigravityAdapter({
    runner,
    projectDir: process.cwd(),
    compatibilityManifestPath: manifestPath,
  });

  const probe = await adapter.probe();
  assert.equal(probe.adapterId, "antigravity");
  assert.equal(probe.available, true);
  assert.ok(probe.capabilities.includes("workspace.write"));

  const stepReq: StepRequest = {
    runId: asRunId("run-1"),
    stepId: asStepId("step-1"),
    phase: "EXECUTE",
    operationId: "op-agy-1",
    workspaceDir: process.cwd(),
    prompt: "do work",
    requiredCapabilities: ["workspace.read", "workspace.write"],
    sideEffect: "workspace-write",
    timeoutMs: 60000,
  };

  const outcome = (await adapter.execute(stepReq, {
    signal: new AbortController().signal,
    elevatedPermissions: false,
  })) as any;

  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.executionId, "op-agy-1");
  assert.equal(outcome.native?.sessionId, "agy-session-123");
  assert.equal(outcome.native?.usage?.totalTokens, 50);
});

test("antigravity-adapter: rejects timeoutMs <= 30000", async () => {
  const runner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const adapter = new AntigravityAdapter({
    runner,
    projectDir: process.cwd(),
    compatibilityManifestPath: manifestPath,
  });

  const stepReq: StepRequest = {
    runId: asRunId("run-1"),
    stepId: asStepId("step-1"),
    phase: "EXECUTE",
    operationId: "op-agy-1",
    workspaceDir: process.cwd(),
    prompt: "do work",
    requiredCapabilities: ["workspace.read", "workspace.write"],
    sideEffect: "workspace-write",
    timeoutMs: 30000, // <= 30000 must reject
  };

  await assert.rejects(
    async () =>
      adapter.execute(stepReq, {
        signal: new AbortController().signal,
        elevatedPermissions: false,
      }),
    /requires timeoutMs > 30000/
  );
});

// Run shared contract suite on Antigravity
runAdapterContractSuite(
  "antigravity",
  async (runner) => {
    return new AntigravityAdapter({
      runner,
      projectDir: process.cwd(),
      compatibilityManifestPath: manifestPath,
      printTimeoutMs: 30000,
    });
  },
  { elevatedFlag: "--dangerously-skip-permissions" }
);

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ClaudeCodeAdapter } from "../../src/v4/adapters/claude/adapter";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";
import { runAdapterContractSuite } from "../../src/v4/testing/adapter-contract";

const manifestPath = path.resolve(__dirname, "../../compatibility/v4/hosts.json");

test("claude-adapter: probe, execute lifecycle, and result correlation", async () => {
  const runner: ProcessRunner = {
    async run(req: ProcessRequest): Promise<ProcessResult> {
      if (req.args.includes("--version")) {
        return {
          stdout: "claude 2.1.185",
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
            "Usage: claude [--print] [--output-format] [--json-schema] [--permission-mode] [--allowedTools] [--session-id]",
          stderr: "",
          durationMs: 5,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      }

      // Simulation of claude output
      const successEnvelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        result: JSON.stringify({
          status: "succeeded",
          executionId: "op-claude-1",
          summary: "Claude completed work",
          artifacts: [],
          evidence: [],
        }),
        session_id: "claude-session-123",
        total_cost_usd: 0.005,
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

  const adapter = new ClaudeCodeAdapter({
    runner,
    projectDir: process.cwd(),
    compatibilityManifestPath: manifestPath,
  });

  const probe = await adapter.probe();
  assert.equal(probe.adapterId, "claude");
  assert.equal(probe.available, true);
  assert.ok(probe.capabilities.includes("workspace.write"));

  const stepReq: StepRequest = {
    runId: asRunId("run-1"),
    stepId: asStepId("step-1"),
    phase: "EXECUTE",
    operationId: "op-claude-1",
    workspaceDir: process.cwd(),
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
  assert.equal(outcome.executionId, "op-claude-1");
  assert.equal(outcome.native?.sessionId, "claude-session-123");
  assert.equal(outcome.native?.usage?.costUsd, 0.005);
});

// Run shared contract suite on Claude
runAdapterContractSuite(
  "claude",
  async (runner) => {
    return new ClaudeCodeAdapter({
      runner,
      projectDir: process.cwd(),
      compatibilityManifestPath: manifestPath,
    });
  },
  { elevatedFlag: "--dangerously-skip-permissions" }
);

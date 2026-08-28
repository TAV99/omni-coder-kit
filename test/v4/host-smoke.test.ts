import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeProcessRunner } from "../../src/v4/process/node-process-runner";
import { createAdapter } from "../../src/v4/adapters/registry";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { StepRequest } from "../../src/v4/contracts/adapter";
import { StepResultSchema } from "../../src/v4/contracts/step-result";

const manifestPath = path.resolve(__dirname, "../../compatibility/v4/hosts.json");

const allowCost = process.env.OMNI_V4_ALLOW_MODEL_COST === "1";
const liveHost = process.env.OMNI_V4_LIVE_HOST as "codex" | "claude" | "antigravity" | undefined;

function parseLiveTimeoutMs(rawValue: string | undefined): number {
  const normalized = rawValue ?? "120000";
  if (!/^\d+$/.test(normalized)) {
    throw new Error("OMNI_V4_LIVE_TIMEOUT_MS must be a positive integer");
  }

  const timeoutMs = Number(normalized);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OMNI_V4_LIVE_TIMEOUT_MS must be a positive integer");
  }

  return timeoutMs;
}

test("live-smoke: rejects invalid timeout overrides", () => {
  for (const invalidValue of ["invalid", "120000ms", "1.5", "0", "-1"]) {
    assert.throws(
      () => parseLiveTimeoutMs(invalidValue),
      /OMNI_V4_LIVE_TIMEOUT_MS/,
      `Expected ${JSON.stringify(invalidValue)} to be rejected`
    );
  }
});

test("live-smoke: uses a safe default and accepts positive integer overrides", () => {
  assert.equal(parseLiveTimeoutMs(undefined), 120000);
  assert.equal(parseLiveTimeoutMs("90000"), 90000);
});

test(
  "live-smoke: executes real CLI in temporary repository",
  { skip: !allowCost || !liveHost },
  async () => {
    if (!liveHost) return;

    const runner = new NodeProcessRunner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-smoke-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    // Initialize git repository
    await runner.run({
      command: "git",
      args: ["init"],
      cwd: workspaceDir,
      timeoutMs: 10000,
    });

    const readmeFile = path.join(workspaceDir, "README.md");
    await fs.writeFile(readmeFile, "# Test Repo\n", "utf-8");

    const adapter = await createAdapter(
      {
        runner,
        projectDir: workspaceDir,
        compatibilityManifestPath: manifestPath,
        allowExperimental: true,
      },
      liveHost === "codex"
        ? { hostId: "codex", tempDir }
        : liveHost === "claude"
        ? { hostId: "claude" }
        : { hostId: "antigravity" }
    );

    const liveTimeoutMs = parseLiveTimeoutMs(
      process.env.OMNI_V4_LIVE_TIMEOUT_MS
    );

    const stepReq: StepRequest = {
      runId: asRunId("smoke-run-1"),
      stepId: asStepId("step-smoke-1"),
      phase: "EXECUTE",
      operationId: "smoke-op-1",
      workspaceDir,
      prompt: "Add a new line 'Smoke test passed.' to README.md and report artifact.",
      requiredCapabilities: ["workspace.read", "workspace.write"],
      sideEffect: "workspace-write",
      timeoutMs: liveTimeoutMs,
    };

    const rawOutcome = await adapter.execute(stepReq, {
      signal: new AbortController().signal,
      elevatedPermissions: false,
    });

    const parsed = StepResultSchema.parse(rawOutcome);
    if (parsed.status !== "succeeded") {
      console.error(
        "[live-smoke diagnostic] StepResult did not succeed:",
        JSON.stringify(parsed, null, 2)
      );
    }
    assert.equal(parsed.status, "succeeded");
    assert.equal(parsed.executionId, "smoke-op-1");

    const modifiedReadme = await fs.readFile(readmeFile, "utf-8");
    assert.ok(
      modifiedReadme.includes("Smoke test passed."),
      "Expected README.md to contain 'Smoke test passed.'"
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  }
);

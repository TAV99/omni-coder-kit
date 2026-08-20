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

    const stepReq: StepRequest = {
      runId: asRunId("smoke-run-1"),
      stepId: asStepId("step-smoke-1"),
      phase: "EXECUTE",
      operationId: "smoke-op-1",
      workspaceDir,
      prompt: "Add a new line 'Smoke test passed.' to README.md and report artifact.",
      requiredCapabilities: ["workspace.read", "workspace.write"],
      sideEffect: "workspace-write",
      timeoutMs: 60000,
    };

    const rawOutcome = await adapter.execute(stepReq, {
      signal: new AbortController().signal,
      elevatedPermissions: false,
    });

    const parsed = StepResultSchema.parse(rawOutcome);
    assert.equal(parsed.status, "succeeded");
    assert.equal(parsed.executionId, "smoke-op-1");

    await fs.rm(tempDir, { recursive: true, force: true });
  }
);

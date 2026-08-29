import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, StepRequest } from "../contracts/adapter";
import { asRunId, asStepId } from "../contracts/ids";
import { StepResultSchema } from "../contracts/step-result";
import {
  createSmokeEvidence,
  renderSmokeEvidenceMarkdown,
  type SmokeEvidence,
} from "./smoke-evidence";

export interface CompatibilitySmokeOptions {
  readonly host: "codex" | "claude" | "antigravity";
  readonly adapter: AgentAdapter;
  readonly manifestOptIn: boolean;
  readonly environmentOptIn: boolean;
  readonly allowModelCost: boolean;
  readonly contractVerified: boolean;
  readonly timeoutMs?: number | undefined;
}

export interface CompatibilitySmokeResult {
  readonly evidence: SmokeEvidence;
  readonly json: string;
  readonly markdown: string;
}

export async function runCompatibilitySmoke(
  options: CompatibilitySmokeOptions
): Promise<CompatibilitySmokeResult> {
  if (!options.manifestOptIn || !options.environmentOptIn || !options.allowModelCost) {
    throw new Error(
      "LIVE_SMOKE_NOT_APPROVED: manifest opt-in, environment opt-in, and runner approval are all required"
    );
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("LIVE_SMOKE_INVALID: timeoutMs must be a positive safe integer");
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-compat-smoke-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const readmePath = path.join(workspaceDir, "README.md");
  const operationId = "compat-smoke-op";
  const startedAt = new Date().toISOString();
  let executionId = "<missing>";
  let structuredStatus: "succeeded" | "failed" | "cancelled" = "failed";
  let mutationVerified = false;
  let modelCallCount = 0;
  let cliVersion = "<missing>";
  let adapterIdentityVerified = false;

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(readmePath, "# Compatibility Smoke\n", "utf8");
    const probe = await options.adapter.probe();
    cliVersion = probe.version ?? "<missing>";
    adapterIdentityVerified =
      probe.available &&
      options.adapter.id === options.host &&
      probe.adapterId === options.host &&
      probe.capabilities.includes("workspace.read") &&
      probe.capabilities.includes("workspace.write") &&
      probe.capabilities.includes("structured-output");
    if (!adapterIdentityVerified) {
      throw new Error("LIVE_SMOKE_ADAPTER_IDENTITY_INVALID");
    }
    const request: StepRequest = {
      runId: asRunId("compat-smoke-run"),
      stepId: asStepId("compat-smoke-step"),
      phase: "EXECUTE",
      operationId,
      workspaceDir,
      prompt: "Append exactly 'Smoke test passed.' on a new line in README.md.",
      requiredCapabilities: ["workspace.read", "workspace.write", "structured-output"],
      sideEffect: "workspace-write",
      timeoutMs,
    };
    modelCallCount = 1;
    const raw = await options.adapter.execute(request, {
      signal: new AbortController().signal,
      elevatedPermissions: false,
    });
    const parsed = StepResultSchema.safeParse(raw);
    if (parsed.success) {
      executionId = parsed.data.executionId;
      structuredStatus =
        parsed.data.status === "succeeded"
          ? "succeeded"
          : parsed.data.status === "cancelled"
            ? "cancelled"
            : "failed";
    }
    mutationVerified = (await fs.readFile(readmePath, "utf8")).includes("Smoke test passed.");
  } catch {
    structuredStatus = "failed";
  } finally {
    const evidence = createSmokeEvidence({
      host: options.host,
      cliVersion,
      platform: `${process.platform}-${process.arch}`,
      operationId,
      executionId,
      startedAt,
      completedAt: new Date().toISOString(),
      structuredStatus,
      mutationVerified,
      contractVerified: options.contractVerified && adapterIdentityVerified,
      modelCallCount,
    });
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    return {
      evidence,
      json: `${JSON.stringify(evidence, null, 2)}\n`,
      markdown: renderSmokeEvidenceMarkdown(evidence),
    };
  }
}

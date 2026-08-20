import type {
  AdapterContext,
  AdapterProbe,
  AgentAdapter,
  StepRequest,
} from "../../contracts/adapter";
import type { Capability } from "../../contracts/run";
import type { ProcessRunner } from "../../process/types";
import { loadCompatibilityManifest } from "../../compatibility/manifest";
import { probeHost } from "../../compatibility/probe";
import { resolvePermissionMode } from "../shared/permission-mode";
import { createAgentStepOutcomeJsonSchema } from "../shared/result-schema";
import { buildAntigravityInvocation } from "./command";
import { parseAntigravityExecution } from "./parser";

export interface AntigravityAdapterOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly model?: string | undefined;
  readonly printTimeoutMs?: number | undefined;
}

const ANTIGRAVITY_CAPABILITIES: readonly Capability[] = [
  "workspace.read",
  "workspace.write",
  "structured-output",
  "cancel",
  "native-resume",
  "usage",
];

export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  private readonly activeExecutions = new Map<string, AbortController>();

  constructor(private readonly options: AntigravityAdapterOptions) {}

  async probe(signal?: AbortSignal): Promise<AdapterProbe> {
    const manifest = await loadCompatibilityManifest(
      this.options.compatibilityManifestPath
    );
    const spec = manifest.hosts.antigravity;
    const probeRes = await probeHost(
      "antigravity",
      spec,
      this.options.runner,
      this.options.projectDir,
      signal
    );

    const isAvailable =
      probeRes.status === "first-class" || probeRes.status === "experimental";

    return {
      adapterId: this.id,
      available: isAvailable,
      capabilities: isAvailable ? ANTIGRAVITY_CAPABILITIES : [],
      version: probeRes.installedVersion,
      diagnostics: probeRes.diagnostics,
    };
  }

  async execute(request: StepRequest, context: AdapterContext): Promise<import("../../contracts/step-result").StepResult> {
    if (request.timeoutMs <= 30_000) {
      throw new Error("AntigravityAdapter requires timeoutMs > 30000");
    }

    if (
      this.options.printTimeoutMs !== undefined &&
      this.options.printTimeoutMs >= request.timeoutMs
    ) {
      throw new Error("Antigravity printTimeoutMs must be strictly less than request.timeoutMs");
    }

    const mode = resolvePermissionMode(request, context);
    const outcomeJsonSchema = createAgentStepOutcomeJsonSchema();
    const printTimeoutMs =
      this.options.printTimeoutMs ??
      Math.max(10_000, request.timeoutMs - 10_000);

    const invocation = buildAntigravityInvocation({
      request,
      mode,
      outcomeJsonSchema,
      printTimeoutMs,
      model: this.options.model,
      resumeSessionId: context.resumeSessionId,
    });

    const executionAbort = new AbortController();
    this.activeExecutions.set(request.operationId, executionAbort);

    const onContextAbort = () => executionAbort.abort();
    if (context.signal.aborted) {
      executionAbort.abort();
    } else {
      context.signal.addEventListener("abort", onContextAbort, { once: true });
    }

    try {
      const processRes = await this.options.runner.run({
        command: invocation.command,
        args: invocation.args,
        cwd: request.workspaceDir,
        timeoutMs: request.timeoutMs,
        signal: executionAbort.signal,
      });

      return parseAntigravityExecution({
        executionId: request.operationId,
        process: processRes,
      });
    } finally {
      context.signal.removeEventListener("abort", onContextAbort);
      this.activeExecutions.delete(request.operationId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    const controller = this.activeExecutions.get(executionId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(executionId);
    }
  }
}

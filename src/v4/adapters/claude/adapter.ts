import crypto from "node:crypto";
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
import {
  DEFAULT_CLAUDE_TOOL_POLICY,
  buildClaudeInvocation,
  type ClaudeToolPolicy,
} from "./command";
import { parseClaudeExecution } from "./parser";

export interface ClaudeCodeAdapterOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly toolPolicy?: ClaudeToolPolicy | undefined;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude";
  private readonly toolPolicy: ClaudeToolPolicy;
  private readonly activeExecutions = new Map<string, AbortController>();

  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    this.toolPolicy = options.toolPolicy ?? DEFAULT_CLAUDE_TOOL_POLICY;
  }

  private deriveCapabilities(): readonly Capability[] {
    const caps: Capability[] = [
      "workspace.read",
      "structured-output",
      "streaming",
      "cancel",
      "native-resume",
      "usage",
    ];

    if (this.toolPolicy.writeTools.length > 0) {
      caps.push("workspace.write");
    }
    if (this.toolPolicy.shellPatterns.length > 0) {
      caps.push("shell");
    }

    return caps;
  }

  async probe(signal?: AbortSignal): Promise<AdapterProbe> {
    const manifest = await loadCompatibilityManifest(
      this.options.compatibilityManifestPath
    );
    const spec = manifest.hosts.claude;
    const probeRes = await probeHost(
      "claude",
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
      capabilities: isAvailable ? this.deriveCapabilities() : [],
      version: probeRes.installedVersion,
      diagnostics: probeRes.diagnostics,
    };
  }

  async execute(
    request: StepRequest,
    context: AdapterContext
  ): Promise<import("../../contracts/step-result").StepResult> {
    const mode = resolvePermissionMode(request, context);
    const outcomeJsonSchema = createAgentStepOutcomeJsonSchema();
    const newSessionId = crypto.randomUUID();

    const invocation = buildClaudeInvocation({
      request,
      mode,
      outcomeJsonSchema,
      toolPolicy: this.toolPolicy,
      newSessionId,
      resumeSessionId: context.resumeSessionId,
    });

    const executionAbort = new AbortController();
    this.activeExecutions.set(request.operationId, executionAbort);

    const onContextAbort = () => {
      executionAbort.abort();
    };

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
        stdin: invocation.stdin,
        timeoutMs: request.timeoutMs,
        signal: executionAbort.signal,
      });

      return parseClaudeExecution({
        executionId: request.operationId,
        process: processRes,
      });
    } finally {
      context.signal.removeEventListener("abort", onContextAbort);
      this.activeExecutions.delete(request.operationId);
    }
  }

  async cancel(operationId: string): Promise<void> {
    const active = this.activeExecutions.get(operationId);
    if (active) {
      active.abort();
      this.activeExecutions.delete(operationId);
    }
  }
}

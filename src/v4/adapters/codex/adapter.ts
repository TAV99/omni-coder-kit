import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
import { createCodexAgentStepOutcomeJsonSchema } from "../shared/result-schema";
import { buildCodexInvocation } from "./command";
import { parseCodexExecution } from "./parser";
import { truncateUtf8Bytes } from "../../contracts/quality";
import type { StepResult } from "../../contracts/step-result";

export interface CodexAdapterOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly tempDir: string;
}

const CODEX_CAPABILITIES: readonly Capability[] = [
  "workspace.read",
  "workspace.write",
  "shell",
  "structured-output",
  "streaming",
  "cancel",
  "native-resume",
  "usage",
];

function redactProcessSummary(value: string): string {
  const redacted = value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s"']+/gi, "$1<redacted>");
  return truncateUtf8Bytes(redacted, 16384);
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  private readonly activeExecutions = new Map<string, AbortController>();

  constructor(private readonly options: CodexAdapterOptions) {}

  async probe(signal?: AbortSignal): Promise<AdapterProbe> {
    const manifest = await loadCompatibilityManifest(
      this.options.compatibilityManifestPath
    );
    const spec = manifest.hosts.codex;
    const probeRes = await probeHost(
      "codex",
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
      capabilities: isAvailable ? CODEX_CAPABILITIES : [],
      version: probeRes.installedVersion,
      diagnostics: probeRes.diagnostics,
    };
  }

  async execute(request: StepRequest, context: AdapterContext): Promise<unknown> {
    const mode = resolvePermissionMode(request, context);
    const opHash = crypto
      .createHash("sha256")
      .update(request.operationId)
      .digest("hex");
    const runStepDir = path.join(this.options.tempDir, `codex-${opHash}`);

    await fs.mkdir(runStepDir, { recursive: true });
    const schemaPath = path.join(runStepDir, "schema.json");
    const resultPath = path.join(runStepDir, "result.json");

    const schemaJson = createCodexAgentStepOutcomeJsonSchema();
    await fs.writeFile(schemaPath, JSON.stringify(schemaJson, null, 2), "utf-8");

    const invocation = buildCodexInvocation({
      request,
      mode,
      schemaPath,
      resultPath,
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
        stdin: invocation.stdin,
        timeoutMs: request.timeoutMs,
        signal: executionAbort.signal,
      });

      let resultText: string | undefined;
      try {
        resultText = await fs.readFile(resultPath, "utf-8");
      } catch {
        // Result file may not have been created on failure
      }

      const parsed = parseCodexExecution(
        resultText !== undefined
          ? {
              executionId: request.operationId,
              process: processRes,
              resultText,
            }
          : {
              executionId: request.operationId,
              process: processRes,
          }
      );
      const normalizedCommand = [
        path.basename(invocation.command),
        ...invocation.args.map((arg) =>
          arg === schemaPath
            ? "<schema-path>"
            : arg === resultPath
              ? "<result-path>"
              : arg === request.workspaceDir
                ? "<workspace>"
                : arg
        ),
      ];
      return {
        ...parsed,
        native: {
          ...parsed.native,
          processEvidence: {
            command: normalizedCommand,
            timeoutMs: request.timeoutMs,
            termination: processRes.termination,
            exitCode: processRes.exitCode,
            stdoutSummary: redactProcessSummary(processRes.stdout),
            stderrSummary: redactProcessSummary(processRes.stderr),
            stdoutSha256: crypto.createHash("sha256").update(processRes.stdout).digest("hex"),
            stderrSha256: crypto.createHash("sha256").update(processRes.stderr).digest("hex"),
          },
        },
      } satisfies StepResult;
    } finally {
      context.signal.removeEventListener("abort", onContextAbort);
      this.activeExecutions.delete(request.operationId);
      try {
        await fs.rm(runStepDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
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

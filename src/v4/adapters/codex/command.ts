import type { StepRequest } from "../../contracts/adapter";
import type { HostInvocation } from "../shared/host-invocation";
import type { AdapterPermissionMode } from "../shared/permission-mode";
import { renderAgentPrompt } from "../shared/prompt";

export interface CodexInvocationInput {
  readonly request: StepRequest;
  readonly mode: AdapterPermissionMode;
  readonly schemaPath: string;
  readonly resultPath: string;
  readonly resumeSessionId?: string | undefined;
}

export function buildCodexInvocation(input: CodexInvocationInput): HostInvocation {
  const args: string[] = ["exec"];

  if (input.resumeSessionId) {
    args.push("resume", input.resumeSessionId);
  }

  args.push(
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.resultPath
  );

  if (input.mode === "elevated") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (input.mode === "read-only") {
    args.push("--sandbox", "read-only");
  } else {
    // workspace-write
    args.push("--approve-for-me");
  }

  args.push("--cd", input.request.workspaceDir, "-");

  return {
    command: "codex",
    args,
    stdin: renderAgentPrompt(input.request),
    resultFile: input.resultPath,
  };
}

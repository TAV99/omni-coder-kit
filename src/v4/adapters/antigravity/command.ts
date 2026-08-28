import type { StepRequest } from "../../contracts/adapter";
import type { HostInvocation } from "../shared/host-invocation";
import type { AdapterPermissionMode } from "../shared/permission-mode";
import { renderAgentPrompt } from "../shared/prompt";

export interface AntigravityInvocationInput {
  readonly request: StepRequest;
  readonly mode: AdapterPermissionMode;
  readonly outcomeJsonSchema: Readonly<Record<string, unknown>>;
  readonly printTimeoutMs: number;
  readonly model?: string | undefined;
  readonly resumeSessionId?: string | undefined;
}

export function buildAntigravityInvocation(
  input: AntigravityInvocationInput
): HostInvocation {
  if (!input.request.workspaceDir) {
    throw new Error("Antigravity requires a non-empty workspaceDir");
  }

  const args: string[] = [];

  if (input.mode === "elevated") {
    args.push("--dangerously-skip-permissions");
  } else if (input.mode === "read-only") {
    args.push("--sandbox", "--mode", "plan");
  } else {
    // workspace-write
    args.push(
      "--sandbox",
      "--mode",
      "accept-edits",
      "--dangerously-skip-permissions"
    );
  }

  args.push("--add-dir", input.request.workspaceDir);
  args.push("--output-format", "json");
  args.push("--json-schema", JSON.stringify(input.outcomeJsonSchema));

  const timeoutSec = Math.max(1, Math.round(input.printTimeoutMs / 1000));
  args.push("--print-timeout", `${timeoutSec}s`);

  if (input.resumeSessionId) {
    args.push("--conversation", input.resumeSessionId);
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  args.push("--print", renderAgentPrompt(input.request));

  return {
    command: "agy",
    args,
  };
}

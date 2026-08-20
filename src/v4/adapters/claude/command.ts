import type { StepRequest } from "../../contracts/adapter";
import type { HostInvocation } from "../shared/host-invocation";
import type { AdapterPermissionMode } from "../shared/permission-mode";
import { renderAgentPrompt } from "../shared/prompt";

export interface ClaudeToolPolicy {
  readonly readTools: readonly string[];
  readonly writeTools: readonly string[];
  readonly shellPatterns: readonly string[];
}

export const DEFAULT_CLAUDE_TOOL_POLICY: ClaudeToolPolicy = {
  readTools: ["Read", "Glob", "Grep"],
  writeTools: ["Edit", "Write"],
  shellPatterns: [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(npm test:*)",
    "Bash(npm run:*)",
  ],
};

export interface ClaudeInvocationInput {
  readonly request: StepRequest;
  readonly mode: AdapterPermissionMode;
  readonly outcomeJsonSchema: Readonly<Record<string, unknown>>;
  readonly toolPolicy: ClaudeToolPolicy;
  readonly newSessionId: string;
  readonly resumeSessionId?: string | undefined;
}

export function buildClaudeInvocation(input: ClaudeInvocationInput): HostInvocation {
  const args: string[] = [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(input.outcomeJsonSchema),
  ];

  if (input.mode === "elevated") {
    args.push("--dangerously-skip-permissions");
  } else if (input.mode === "read-only") {
    args.push(
      "--permission-mode",
      "plan",
      "--allowedTools",
      input.toolPolicy.readTools.join(",")
    );
  } else {
    // workspace-write
    const allowed = [
      ...input.toolPolicy.readTools,
      ...input.toolPolicy.writeTools,
      ...input.toolPolicy.shellPatterns,
    ];
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      allowed.join(",")
    );
  }

  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  } else {
    args.push("--session-id", input.newSessionId);
  }

  args.push(renderAgentPrompt(input.request));

  return {
    command: "claude",
    args,
  };
}

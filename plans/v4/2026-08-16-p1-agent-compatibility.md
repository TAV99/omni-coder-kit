# Omni v4 P1 Agent Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, version-aware, contract-tested v4 adapters for Codex, Claude Code, and Antigravity without leaking host-specific commands, output formats, or permission behavior into the v4 core.

**Architecture:** Each host integration has three isolated units: a pure argv builder, an untrusted native-output parser, and an `AgentAdapter` implementation. All process execution goes through an argv-only `ProcessRunner` with `shell: false`. Compatibility is evidence-based: binary/version/required-flag probes plus shared contract tests determine whether an adapter is `first-class`, `experimental`, or `unavailable`.

**Tech Stack:** P0 TypeScript/Node.js 20 kernel, Node `child_process.spawn`, Zod boundary parsing, `node:test`, host CLI structured output, and JSON fixtures captured from explicitly approved smoke runs.

## Global Constraints

- Complete and verify every task in `plans/v4/2026-08-15-p0-correctness-safety.md` first.
- Do not rename or widen the P0 `AgentAdapter`, `StepRequest`, `AdapterContext`, `AgentStepOutcome`, `StepResult`, `AdapterProbe`, or capability contracts.
- Treat stdout, stderr, exit codes, session IDs, JSONL events, version strings, and help text as untrusted input.
- Never construct a shell command string. Pass `command` and `args` separately with `shell: false`.
- Never add elevated flags unless `AdapterContext.elevatedPermissions === true` and central policy already returned `allow`.
- A process exit code of `0` is necessary but not sufficient for success.
- A final prose message is never sufficient for success.
- Parse model-authored structured output through `AgentStepOutcomeSchema`, derive native session/usage only from trusted CLI envelope/events, combine them into an Omni `StepResult`, then let the P0 controller validate it again.
- Never accept `native` metadata from model-authored structured output. Host parsers own `StepResult.native` and normalize only fields proven by native output.
- Advertise `usage` only when the current version probe and parser fixtures prove at least one normalized usage field can be populated from native output.
- Put model names, native flags, CLI output quirks, and version handling inside the relevant adapter directory.
- Default host configuration must not commit, push, publish, deploy, access unrelated directories, or bypass sandbox/permissions.
- Live agent smoke tests require explicit user approval because they use network/model quota and modify a temporary workspace.
- Never commit, push, tag, publish, or deploy unless the user gives explicit permission in the active session.
- At each commit checkpoint, report the suggested commit message and wait if commit permission has not been granted.

## Verified Planning Baseline

These versions and required flags were re-verified locally on 2026-08-20. Implementation agents must still re-run the listed help commands and update `compatibility/v4/hosts.json` when the installed version differs.

| Host | Observed version | Verification command | Structured output | Safe workspace mode |
|---|---:|---|---|---|
| Codex | `0.147.0` | `codex exec --help` | `--json`, `--output-schema`, `-o` | `--sandbox workspace-write --approve-for-me` |
| Claude Code | `2.1.185` | `claude --help` | `--output-format json`, `--json-schema` | `--permission-mode acceptEdits` plus explicit tool allowlist |
| Antigravity | `1.1.13` | `agy --help` | `--output-format json`, `--json-schema` | `--sandbox --mode accept-edits --add-dir <workspace>` |

Authoritative references used by this plan:

- OpenAI Codex exec CLI source: https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs
- OpenAI Codex Action structured-output forwarding: https://github.com/openai/codex-action
- Anthropic Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Antigravity public flag documentation was not located during planning; `agy 1.1.13 --help` is the recorded baseline and must be re-verified locally.

## Definition of P1 Done

- Shared adapter contract tests pass unchanged for all three adapters.
- Each adapter has pure argv tests proving safe and elevated modes differ only when explicitly requested.
- Missing binaries, unknown versions, missing required flags, malformed structured output, non-zero exits, timeout, and cancellation produce non-success results.
- `compatibility/v4/hosts.json` records verified version, date, required flags, and status.
- No safe-mode argv contains `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-skip-permissions`.
- Codex, Claude Code, and Antigravity complete approved temporary-workspace smoke tests or remain `experimental` with the missing evidence stated.
- P0 controller fault-injection tests and all v3 tests continue to pass.

## Locked File Structure

```text
compatibility/v4/
  hosts.json
  README.md
src/v4/
  process/
    types.ts
    node-process-runner.ts
  compatibility/
    manifest.ts
    probe.ts
  adapters/
    shared/
      host-invocation.ts
      prompt.ts
      permission-mode.ts
      result-schema.ts
      adapter-failure.ts
    codex/
      command.ts
      parser.ts
      adapter.ts
    claude/
      command.ts
      parser.ts
      adapter.ts
    antigravity/
      command.ts
      parser.ts
      adapter.ts
    registry.ts
  testing/
    adapter-contract.ts
test/v4/
  process-runner.test.ts
  compatibility.test.ts
  adapter-contract.test.ts
  codex-command.test.ts
  codex-parser.test.ts
  codex-adapter.test.ts
  claude-command.test.ts
  claude-parser.test.ts
  claude-adapter.test.ts
  antigravity-command.test.ts
  antigravity-parser.test.ts
  antigravity-adapter.test.ts
  adapter-registry.test.ts
  host-smoke.test.ts
test/fixtures/v4/hosts/
  codex/
  claude/
  antigravity/
```

## Additional Stable Interfaces Produced by P1

```ts
export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type ProcessResult =
  | (ProcessOutput & {
      readonly termination: "exited";
      readonly exitCode: number;
      readonly signal: null;
    })
  | (ProcessOutput & {
      readonly termination: "signalled";
      readonly exitCode: null;
      readonly signal: NodeJS.Signals;
    })
  | (ProcessOutput & {
      readonly termination: "timed-out" | "aborted" | "output-limit";
      readonly exitCode: null;
      readonly signal: NodeJS.Signals | null;
    })
  | (ProcessOutput & {
      readonly termination: "spawn-error";
      readonly exitCode: null;
      readonly signal: null;
      readonly error: { readonly code: string; readonly message: string };
    });

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export type CompatibilityStatus =
  | "first-class"
  | "experimental"
  | "incompatible"
  | "unavailable";

export interface HostCompatibilityResult {
  readonly hostId: "codex" | "claude" | "antigravity";
  readonly status: CompatibilityStatus;
  readonly installedVersion?: string;
  readonly verifiedVersion?: string;
  readonly missingFlags: readonly string[];
  readonly contractVerified: boolean;
  readonly liveSmokeVerified: boolean;
  readonly platformVerified: boolean;
  readonly diagnostics: readonly string[];
}
```

---

### Task 1: Implement a safe cross-platform process runner

**Files:**
- Create: `src/v4/process/types.ts`
- Create: `src/v4/process/node-process-runner.ts`
- Modify: `src/v4/index.ts`
- Test: `test/v4/process-runner.test.ts`
- Create fixture: `test/fixtures/v4/process-fixture.cjs`

**Interfaces:**
- Consumes: Node.js `spawn`, `AbortSignal`, and injected clock.
- Produces: `ProcessRunner`, `ProcessRequest`, `ProcessResult`, and `NodeProcessRunner`.

- [ ] **Step 1: Create a deterministic child-process fixture**

Create `test/fixtures/v4/process-fixture.cjs`:

```js
"use strict";

const mode = process.argv[2];

if (mode === "echo") {
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ args: process.argv.slice(3), input }));
  });
} else if (mode === "stderr") {
  process.stderr.write("fixture-error");
  process.exit(7);
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(11 * 1024 * 1024));
} else if (mode === "signal" && process.platform !== "win32") {
  process.kill(process.pid, "SIGTERM");
} else {
  process.stderr.write("unknown fixture mode");
  process.exit(2);
}
```

- [ ] **Step 2: Write process runner tests**

Assert arguments containing spaces and shell metacharacters arrive unchanged; stdin is written and closed; stdout/stderr remain separate; exit code `7` is preserved; timeout, external abort, output overflow, and nonexistent binary each produce the exact distinct `termination`; and `shell` cannot be enabled because it is absent from `ProcessRequest`. Test `signalled` on non-Windows only and state the platform condition in the test name.

- [ ] **Step 3: Implement `NodeProcessRunner`**

Use:

```ts
spawn(request.command, [...request.args], {
  cwd: request.cwd,
  env: request.env ? { ...process.env, ...request.env } : process.env,
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
```

Bound stdout and stderr to 10 MiB each. When either limit is exceeded, terminate the child and return `termination: "output-limit"`. Return spawn failures as `termination: "spawn-error"`; do not reject the promise for expected process outcomes. Use one cleanup function for timer, abort listener, and child listeners; never resolve twice. Parsers may inspect native output only when `termination === "exited" && exitCode === 0`.

- [ ] **Step 4: Verify on Windows**

Run `npm run test:v4` and `npm run typecheck:v4`.

Expected: metacharacter tests prove no shell interpolation; timeout and abort leave no fixture process running.

- [ ] **Step 5: Prepare the commit checkpoint**

Report suggested message `feat(v4): add argv-only process runner`. Do not commit without explicit permission.

---

### Task 2: Add the versioned compatibility manifest and flag probes

**Files:**
- Create: `compatibility/v4/hosts.json`
- Create: `compatibility/v4/README.md`
- Create: `src/v4/compatibility/manifest.ts`
- Create: `src/v4/compatibility/probe.ts`
- Test: `test/v4/compatibility.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner`.
- Produces: `loadCompatibilityManifest(path)` and `probeHost(spec, runner, cwd)`.

- [ ] **Step 1: Re-run local probes**

Run `codex --version`, `codex exec --help`, `claude --version`, `claude --help`, `agy --version`, and `agy --help`. If a binary is absent, record it as unavailable. If a version differs, use the observed value and document the difference.

- [ ] **Step 2: Create the initial strict manifest**

Create `compatibility/v4/hosts.json`:

```json
{
  "schemaVersion": 1,
  "verifiedAt": "2026-08-20",
  "hosts": {
    "codex": {
      "binary": "codex",
      "verifiedVersion": "0.147.0",
      "versionArgs": ["--version"],
      "helpArgs": ["exec", "--help"],
      "requiredFlags": ["--json", "--strict-config", "--ignore-user-config", "--output-schema", "--output-last-message", "--sandbox", "--approve-for-me", "--cd"],
      "contractVerified": false,
      "liveSmokeVerified": false,
      "verifiedPlatforms": []
    },
    "claude": {
      "binary": "claude",
      "verifiedVersion": "2.1.185",
      "versionArgs": ["--version"],
      "helpArgs": ["--help"],
      "requiredFlags": ["--print", "--output-format", "--json-schema", "--permission-mode", "--allowedTools", "--session-id"],
      "contractVerified": false,
      "liveSmokeVerified": false,
      "verifiedPlatforms": []
    },
    "antigravity": {
      "binary": "agy",
      "verifiedVersion": "1.1.13",
      "versionArgs": ["--version"],
      "helpArgs": ["--help"],
      "requiredFlags": ["--print", "--output-format", "--json-schema", "--mode", "--sandbox", "--add-dir", "--print-timeout"],
      "contractVerified": false,
      "liveSmokeVerified": false,
      "verifiedPlatforms": []
    }
  }
}
```

Update values only from actual probe output.

- [ ] **Step 3: Write manifest and probe tests**

Cover malformed manifest rejection, missing binary, missing required flag, exact verified version, newer unverified version, and stderr-only version output.

Status rules, evaluated in this order:

- `unavailable`: binary cannot launch.
- `incompatible`: version cannot be parsed or any required flag is missing.
- `experimental`: binary/flags are usable, but version differs, contract/live-smoke evidence is absent, or the current `` `${process.platform}-${process.arch}` `` key is not in `verifiedPlatforms`.
- `first-class`: installed version equals verified version, every required flag is present, both evidence booleans are true, and the current platform is recorded.

- [ ] **Step 4: Implement strict parsing and probes**

Use Zod for disk JSON. Extract the first `x.y.z` sequence from combined stdout/stderr. Do not depend on surrounding localized text.

- [ ] **Step 5: Document promotion behavior**

State in `compatibility/v4/README.md` that changing `verifiedVersion`, either evidence boolean, or `verifiedPlatforms` requires exact contract commands and an approved smoke run recorded in the README. Editing JSON alone is not evidence; review must reject evidence bits without a matching dated record.

- [ ] **Step 6: Verify and checkpoint**

Run `npm run test:v4` and `npm run typecheck:v4`. Report suggested message `feat(v4): add evidence-based host compatibility probes`. Do not commit without explicit permission.

---

### Task 3: Add shared permission, schema, failure, and contract helpers

**Files:**
- Create: `src/v4/adapters/shared/host-invocation.ts`
- Create: `src/v4/adapters/shared/prompt.ts`
- Create: `src/v4/adapters/shared/permission-mode.ts`
- Create: `src/v4/adapters/shared/result-schema.ts`
- Create: `src/v4/adapters/shared/adapter-failure.ts`
- Create: `src/v4/testing/adapter-contract.ts`
- Test: `test/v4/adapter-contract.test.ts`

**Interfaces:**
- Consumes: P0 schemas and `AgentAdapter`.
- Produces: `HostInvocation`, `renderAgentPrompt`, `AdapterPermissionMode`, `createAgentStepOutcomeJsonSchema`, failure builders, and `runAdapterContractSuite(factory)`.

- [ ] **Step 1: Define the host-neutral invocation contract**

```ts
export interface HostInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly resultFile?: string;
}
```

Keep this type in `adapters/shared`; no host adapter may import a command type from another host directory.

- [ ] **Step 2: Define the shared agent protocol prompt**

```ts
export function renderAgentPrompt(request: StepRequest): string;
```

Return a fixed control preamble followed by one compact JSON object containing `protocol: "omni-v4"`, `executionId: request.operationId`, `stepId`, `phase`, `workspaceDir`, and `task: request.prompt`. The preamble must require: work only inside `workspaceDir`; return exactly one `AgentStepOutcome`; echo the exact execution ID; use workspace-relative artifact claims; set every evidence `producerStepId` to the provided step ID; and never emit `native` metadata. Test quotes, newlines, shell metacharacters, and instruction-like task text: they must remain inside the serialized `task` value and must not add argv entries.

- [ ] **Step 3: Define permission resolution**

```ts
export type AdapterPermissionMode = "read-only" | "workspace-write" | "elevated";

export function resolvePermissionMode(
  request: StepRequest,
  context: AdapterContext,
): AdapterPermissionMode;
```

Rules: explicit elevated context selects elevated; read-only selects read-only; workspace-write selects workspace-write; external without elevated approval throws `AdapterPolicyError`.

- [ ] **Step 4: Generate model-facing JSON Schema from the P0 boundary**

Implement `createAgentStepOutcomeJsonSchema()` using Zod 4 JSON Schema generation from `AgentStepOutcomeSchema`. Return a fresh plain object. Test all four status variants, required `failure.signature`, strict rejection of `native`, and absence of adapter-owned session/usage fields from the emitted JSON Schema.

- [ ] **Step 5: Add consistent adapter failures**

```ts
export function processFailure(input: {
  executionId: string;
  hostId: string;
  code: "BINARY_MISSING" | "SPAWN_ERROR" | "CLI_EXIT" | "SIGNAL" | "TIMEOUT" | "ABORTED" | "OUTPUT_LIMIT";
  message: string;
  retryable: boolean;
}): StepResult;

export function malformedOutputFailure(
  executionId: string,
  hostId: string,
  detail: string,
): StepResult;
```

Derive stable signatures from host ID, code, and normalized detail; exclude timestamps and temporary paths.

- [ ] **Step 6: Implement the shared contract suite**

The reusable suite must assert probe behavior; safe mode contains no dangerous flag; explicit elevated mode contains exactly the expected elevated flag; non-zero exit, timeout, abort, and malformed output are non-success; model output containing `native` is rejected; valid structured success plus native metadata passes `StepResultSchema`; and cancellation is idempotent.

- [ ] **Step 7: Verify and checkpoint**

Run `npm run test:v4` and `npm run typecheck:v4`. Report suggested message `feat(v4): standardize adapter safety contracts`. Do not commit without explicit permission.

---

### Task 4: Implement the Codex argv builder and JSONL parser

**Files:**
- Create: `src/v4/adapters/codex/command.ts`
- Create: `src/v4/adapters/codex/parser.ts`
- Test: `test/v4/codex-command.test.ts`
- Test: `test/v4/codex-parser.test.ts`
- Create: `test/fixtures/v4/hosts/codex/success.jsonl`
- Create: `test/fixtures/v4/hosts/codex/failed.jsonl`

**Interfaces:**
- Consumes: shared `HostInvocation`, permission mode, JSON Schema, `StepRequest`, and `ProcessResult`.
- Produces: `buildCodexInvocation(input)` and `parseCodexExecution(input): StepResult`.

- [ ] **Step 1: Define and test the invocation surface**

```ts
export function buildCodexInvocation(input: {
  readonly request: StepRequest;
  readonly mode: AdapterPermissionMode;
  readonly schemaPath: string;
  readonly resultPath: string;
  readonly resumeSessionId?: string;
}): HostInvocation;

export function parseCodexExecution(input: {
  readonly executionId: string;
  readonly process: ProcessResult;
  readonly resultText?: string;
}): StepResult;
```

Safe workspace-write argv must contain `exec --json --strict-config --ignore-user-config --output-schema <schemaPath> --output-last-message <resultPath> --sandbox workspace-write --approve-for-me --cd <workspaceDir> -`. Supply `renderAgentPrompt(request)` through stdin.

Read-only uses `--sandbox read-only` and omits `--approve-for-me`. Elevated uses `--dangerously-bypass-approvals-and-sandbox` and omits sandbox/approve flags. No mode adds `--dangerously-bypass-hook-trust`.

- [ ] **Step 2: Add sanitized fixtures**

With explicit model-call approval, capture a harmless temp-repo execution. Without approval, use documented OpenAI event types and keep status experimental. Minimum JSONL success fixture:

```jsonl
{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000001"}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}
```

Store the final schema-valid `StepResult` in a separate result-file fixture.

- [ ] **Step 3: Write parser rejection tests**

Reject non-zero exit even with a good result file; missing/invalid result file; schema-invalid result; malformed JSONL; and missing completion event. Parse the result file through `AgentStepOutcomeSchema`. Map a proven thread ID and normalized token counters from JSONL into `StepResult.native`.

- [ ] **Step 4: Implement without prose fallback**

Parse JSONL only for completion/session/usage metadata and parse only the result file for the model-authored outcome. Never interpret the last stdout line as success and never accept `native` fields from the result file.

- [ ] **Step 5: Verify and checkpoint**

Run `npm run test:v4` and `npm run typecheck:v4`. Report suggested message `feat(v4): build and parse Codex executions`. Do not commit without explicit permission.

---

### Task 5: Implement the Codex adapter and contract suite

**Files:**
- Create: `src/v4/adapters/codex/adapter.ts`
- Modify: `src/v4/index.ts`
- Test: `test/v4/codex-adapter.test.ts`
- Modify: `test/v4/adapter-contract.test.ts`

**Interfaces:**
- Consumes: Codex builder/parser, `ProcessRunner`, compatibility probe, and P0 adapter contract.
- Produces: `CodexAdapter` implementing `AgentAdapter`.

- [ ] **Step 1: Write adapter lifecycle tests**

Using an injected fake runner and temporary directory, test probe, execute, timeout, abort, cancellation, result/schema-file cleanup, session ID propagation, and exact correlation `result.executionId === request.operationId`.

- [ ] **Step 2: Implement the constructor surface**

```ts
export interface CodexAdapterOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly tempDir: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  constructor(options: CodexAdapterOptions);
  probe(signal?: AbortSignal): Promise<AdapterProbe>;
  execute(request: StepRequest, context: AdapterContext): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}
```

- [ ] **Step 3: Map capabilities conservatively**

Advertise `workspace.read`, `workspace.write`, `shell`, `structured-output`, `streaming`, `cancel`, `native-resume`, and `usage` only when their required flags and parser fixtures are present. Do not advertise `subagents` during P1.

- [ ] **Step 4: Implement execution cleanup**

For each call, derive a filesystem-safe directory name as lower-case SHA-256 of `request.operationId`; write unique schema/result files only inside that directory and remove them in `finally`. Never use the raw operation ID as a path segment. Track active executions in a `Map<string, AbortController>` keyed by `request.operationId`; combine the local signal with `context.signal`, and make `cancel(operationId)` idempotent.

- [ ] **Step 5: Pass the shared suite unchanged**

Register:

```ts
runAdapterContractSuite("codex", factory, {
  elevatedFlag: "--dangerously-bypass-approvals-and-sandbox",
});
```

Do not add Codex-specific exemptions to shared assertions.

- [ ] **Step 6: Verify real controller integration with a fake process boundary**

Use P0 `RunController` and real `CodexAdapter`. Fake only `ProcessRunner`. Prove valid structured output advances exactly once and malformed output never appends `run.transitioned`.

- [ ] **Step 7: Run gates and checkpoint**

Run `npm run test:v4`, `npm run typecheck:v4`, and `npm test`. Report suggested message `feat(v4): add contract-tested Codex adapter`. Do not commit without explicit permission.

---

### Task 6: Implement the Claude Code argv builder and result parser

**Files:**
- Create: `src/v4/adapters/claude/command.ts`
- Create: `src/v4/adapters/claude/parser.ts`
- Test: `test/v4/claude-command.test.ts`
- Test: `test/v4/claude-parser.test.ts`
- Create: `test/fixtures/v4/hosts/claude/success.json`
- Create: `test/fixtures/v4/hosts/claude/failed.json`

**Interfaces:**
- Consumes: shared `HostInvocation`, permission and schema helpers, `StepRequest`, and `ProcessResult`.
- Produces: `ClaudeToolPolicy`, `buildClaudeInvocation(input): HostInvocation`, and `parseClaudeExecution(input): StepResult`.

- [ ] **Step 1: Define the safe default tool policy**

```ts
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

export function buildClaudeInvocation(input: {
  readonly request: StepRequest;
  readonly mode: AdapterPermissionMode;
  readonly outcomeJsonSchema: Readonly<Record<string, unknown>>;
  readonly toolPolicy: ClaudeToolPolicy;
  readonly newSessionId: string;
  readonly resumeSessionId?: string;
}): HostInvocation;

export function parseClaudeExecution(input: {
  readonly executionId: string;
  readonly process: ProcessResult;
}): StepResult;
```

Do not add `git commit`, `git push`, `npm publish`, arbitrary `Bash`, web, messaging, or external-system tools.

- [ ] **Step 2: Write pure argv tests**

Safe workspace-write invocation must contain:

```text
claude --print --output-format json --json-schema <minifiedSchema>
--permission-mode acceptEdits --allowedTools <commaSeparatedTools>
--session-id <uuid> <renderedPrompt>
```

Read-only uses `--permission-mode plan` and only read tools. Elevated contains `--dangerously-skip-permissions` only when explicitly selected. Do not treat `--allow-dangerously-skip-permissions` as elevation; it only enables a later option.

Resume mode replaces `--session-id <uuid>` with `--resume <sessionId>`.

Pass the complete `renderAgentPrompt(request)` as one argv element. Tests must prove task text containing spaces or shell metacharacters never creates additional args.

- [ ] **Step 3: Add sanitized result fixtures**

Use this documented minimum success envelope:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 100,
  "duration_api_ms": 80,
  "num_turns": 1,
  "result": "{\"status\":\"succeeded\",\"executionId\":\"exec-1\",\"summary\":\"ok\",\"artifacts\":[],\"evidence\":[]}",
  "session_id": "00000000-0000-0000-0000-000000000002",
  "total_cost_usd": 0.001
}
```

Support a future `structured_output` field by preferring it when present. Reject when neither it nor a parseable `result` exists.

- [ ] **Step 4: Write parser tests before implementation**

Reject non-zero exit, `is_error: true`, non-success subtype, invalid envelope, invalid nested JSON, and schema-invalid result. Parse the nested result through `AgentStepOutcomeSchema`; therefore any model-authored `native` field is invalid. Map the envelope session ID, cost, and any proven token counters into `StepResult.native`; duration and turn count remain parser diagnostics/smoke evidence because they are not usage counters.

- [ ] **Step 5: Implement strict parsing**

Use a Zod envelope schema with `.strict()`. Parse the nested structured candidate once through `StepResultSchema`. Never use the human-readable result when JSON parsing fails.

- [ ] **Step 6: Verify and checkpoint**

Run `npm run test:v4` and `npm run typecheck:v4`. Report suggested message `feat(v4): build and parse Claude Code executions`. Do not commit without explicit permission.

---

### Task 7: Implement the Claude Code adapter and contract suite

**Files:**
- Create: `src/v4/adapters/claude/adapter.ts`
- Test: `test/v4/claude-adapter.test.ts`
- Modify: `test/v4/adapter-contract.test.ts`

**Interfaces:**
- Consumes: Claude builder/parser, tool policy, process runner, and compatibility probe.
- Produces: `ClaudeCodeAdapter` implementing `AgentAdapter`.

- [ ] **Step 1: Write adapter lifecycle tests**

Using a fake runner, verify probe, tool-policy mapping, JSON parsing, timeout, abort, cancellation keyed by `request.operationId`, exact result correlation, native session resume, native usage/cost normalization, and that these fields cannot turn a failed outcome into success.

- [ ] **Step 2: Implement the constructor surface**

```ts
export interface ClaudeCodeAdapterOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly toolPolicy?: ClaudeToolPolicy;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude";
  constructor(options: ClaudeCodeAdapterOptions);
  probe(signal?: AbortSignal): Promise<AdapterProbe>;
  execute(request: StepRequest, context: AdapterContext): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}
```

- [ ] **Step 3: Advertise capabilities from actual configuration**

Do not advertise `shell` when `shellPatterns` is empty. Do not advertise `workspace.write` when write tools are absent. Advertise native resume only when `--resume` is present in the current help output.

Maintain a `Map<string, AbortController>` keyed by `request.operationId`, combine its signal with `context.signal`, delete the entry in `finally`, and make `cancel(operationId)` idempotent. Pass `request.operationId` to the parser as `executionId`; never accept a different model-authored value.

- [ ] **Step 4: Pass the shared suite unchanged**

Use elevated flag `--dangerously-skip-permissions`. Do not bypass shared assertions for Claude-specific behavior.

- [ ] **Step 5: Verify controller integration**

Use real controller plus real Claude adapter with fake process runner. Prove prose-only nested result, even with exit `0`, cannot transition.

- [ ] **Step 6: Run gates and checkpoint**

Run `npm run test:v4`, `npm run typecheck:v4`, and `npm test`. Report suggested message `feat(v4): add contract-tested Claude Code adapter`. Do not commit without explicit permission.

---

### Task 8: Implement the Antigravity argv builder and result parser

**Files:**
- Create: `src/v4/adapters/antigravity/command.ts`
- Create: `src/v4/adapters/antigravity/parser.ts`
- Test: `test/v4/antigravity-command.test.ts`
- Test: `test/v4/antigravity-parser.test.ts`
- Create: `test/fixtures/v4/hosts/antigravity/success.json`
- Create: `test/fixtures/v4/hosts/antigravity/failed.json`

**Interfaces:**
- Consumes: shared `HostInvocation`, permission and schema helpers, `StepRequest`, and `ProcessResult`.
- Produces: `buildAntigravityInvocation(input): HostInvocation` and `parseAntigravityExecution(input): StepResult`.

- [ ] **Step 1: Write pure argv tests**

Use these exact public signatures:

```ts
export function buildAntigravityInvocation(input: {
  readonly request: StepRequest;
  readonly mode: AdapterPermissionMode;
  readonly outcomeJsonSchema: Readonly<Record<string, unknown>>;
  readonly printTimeoutMs: number;
  readonly model?: string;
}): HostInvocation;

export function parseAntigravityExecution(input: {
  readonly executionId: string;
  readonly process: ProcessResult;
}): StepResult;
```

Safe workspace-write invocation must contain:

```text
agy --sandbox --mode accept-edits --add-dir <workspaceDir>
--output-format json --json-schema <minifiedSchema>
--print-timeout <duration> --print <renderedPrompt>
```

Read-only uses `--sandbox --mode plan`. Elevated contains `--dangerously-skip-permissions` only when explicitly selected. Every mode includes `--add-dir <workspaceDir>`; reject a missing/non-directory workspace before building argv.

Do not hard-code model IDs. Accept an optional model from adapter options and add `--model` only when provided.

Pass the complete `renderAgentPrompt(request)` as one argv element after `--print`; do not concatenate it into a shell string.

- [ ] **Step 2: Capture the native envelope before promotion**

With explicit model-call approval, capture `agy 1.1.13 --output-format json` in a temporary project and sanitize paths/prompt text. Without approval, retain experimental status and test only the explicitly defined fixture shapes.

The parser may accept either a direct `StepResult` object or one envelope containing `structured_output` or parseable `result`. It must not recursively search arbitrary nested objects for success-like content.

- [ ] **Step 3: Write rejection tests**

Reject timeout, process non-zero, invalid JSON, explicit error envelope, missing final structured result, and schema-invalid result. Parse the structured candidate through `AgentStepOutcomeSchema`; map only native-envelope conversation/session and usage fields into `StepResult.native`.

- [ ] **Step 4: Implement strict parser and dual timeout input**

The builder accepts both `timeoutMs` and computed `printTimeoutMs`. Require outer `timeoutMs > 30_000`; compute native timeout as `Math.max(30_000, timeoutMs - 30_000)` and require it to remain strictly below the outer timeout.

- [ ] **Step 5: Verify and checkpoint**

Run `npm run test:v4` and `npm run typecheck:v4`. Report suggested message `feat(v4): build and parse Antigravity executions`. Do not commit without explicit permission.

---

### Task 9: Implement the Antigravity adapter and contract suite

**Files:**
- Create: `src/v4/adapters/antigravity/adapter.ts`
- Test: `test/v4/antigravity-adapter.test.ts`
- Modify: `test/v4/adapter-contract.test.ts`

**Interfaces:**
- Consumes: Antigravity builder/parser, process runner, compatibility probe, and P0 adapter contract.
- Produces: `AntigravityAdapter` implementing `AgentAdapter`.

- [ ] **Step 1: Write lifecycle and workspace tests**

Assert unavailable binary, version mismatch, missing workspace, missing `--add-dir`, safe mode, explicit elevation, timeout, cancellation keyed by `request.operationId`, exact result correlation, malformed native output, and valid structured success.

- [ ] **Step 2: Implement the constructor surface**

```ts
export interface AntigravityAdapterOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly model?: string;
  readonly printTimeoutMs?: number;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  constructor(options: AntigravityAdapterOptions);
  probe(signal?: AbortSignal): Promise<AdapterProbe>;
  execute(request: StepRequest, context: AdapterContext): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}
```

- [ ] **Step 3: Use two timeout boundaries**

Require `StepRequest.timeoutMs > 30_000`. Set native `--print-timeout` to `Math.max(30_000, timeoutMs - 30_000)`; the process runner remains the authoritative outer timeout. Reject rather than silently rewriting an outer timeout of 30 seconds or less.

Maintain a `Map<string, AbortController>` keyed by `request.operationId`, combine its signal with `context.signal`, delete the entry in `finally`, and make `cancel(operationId)` idempotent. Pass the same operation ID into the parser as `executionId`.

- [ ] **Step 4: Map capabilities conservatively**

Advertise workspace, structured output, cancel, native resume, and usage only when current help/fixtures prove them. Do not advertise `subagents` merely because Antigravity has Manager View; P1 tests only headless adapter behavior.

- [ ] **Step 5: Pass the shared suite unchanged**

Use elevated flag `--dangerously-skip-permissions`. Prove every safe argv omits it.

- [ ] **Step 6: Verify controller integration and gates**

Use real P0 controller plus Antigravity adapter with fake process runner. Run `npm run test:v4`, `npm run typecheck:v4`, and `npm test`.

Expected: valid structured result advances; malformed and timeout results do not.

- [ ] **Step 7: Prepare the commit checkpoint**

Report suggested message `feat(v4): add contract-tested Antigravity adapter`. Do not commit without explicit permission.

---

### Task 10: Add the adapter registry and status enforcement

**Files:**
- Create: `src/v4/adapters/registry.ts`
- Modify: `src/v4/index.ts`
- Test: `test/v4/adapter-registry.test.ts`

**Interfaces:**
- Consumes: Three adapter constructors and compatibility results.
- Produces: `createAdapter(hostId, options)` and `listAdapterStatuses(options)`.

- [ ] **Step 1: Write registry tests**

Assert known IDs construct the correct adapter, unknown IDs throw `UnsupportedAdapterError`, unavailable/incompatible adapters are listed but cannot start, experimental adapters require explicit `allowExperimental: true`, and only fully evidenced current-platform entries are first-class.

- [ ] **Step 2: Implement the exact registry input**

```ts
export type HostId = "codex" | "claude" | "antigravity";

export interface AdapterRegistryOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly allowExperimental: boolean;
}

export type AdapterHostOptions =
  | { readonly hostId: "codex"; readonly tempDir: string }
  | { readonly hostId: "claude"; readonly toolPolicy?: ClaudeToolPolicy }
  | {
      readonly hostId: "antigravity";
      readonly model?: string;
      readonly printTimeoutMs?: number;
    };

export function createAdapter(
  options: AdapterRegistryOptions,
  host: AdapterHostOptions,
): Promise<AgentAdapter>;

export function listAdapterStatuses(
  options: Omit<AdapterRegistryOptions, "allowExperimental">,
): Promise<readonly HostCompatibilityResult[]>;
```

Do not add a bag of `unknown` host options. `createAdapter` probes before construction; it rejects `unavailable`, and rejects `experimental` unless `allowExperimental` is exactly `true`.

- [ ] **Step 3: Enforce status before construction**

Do not defer status rejection until the first model call. Probe and compute status before returning an executable adapter. Always reject unavailable/incompatible; reject experimental unless explicitly allowed.

- [ ] **Step 4: Keep core vendor-neutral**

Run:

```powershell
rg -n "codex|claude|antigravity|agy" src/v4/core src/v4/policy src/v4/storage src/v4/contracts
```

Expected: no vendor name appears in core, policy, storage, or contracts.

- [ ] **Step 5: Verify exports and checkpoint**

Run `npm run test:v4`, `npm run typecheck:v4`, and `npm run build:v4`. Report suggested message `feat(v4): register adapters by verified status`. Do not commit without explicit permission.

---

### Task 11: Capture approved live-smoke evidence and promote eligible adapters

**Files:**
- Create or modify: `test/v4/host-smoke.test.ts`
- Modify fixtures under: `test/fixtures/v4/hosts/`
- Modify: `compatibility/v4/hosts.json`
- Modify: `compatibility/v4/README.md`
- Modify: `ROADMAP_V4.md`

**Interfaces:**
- Consumes: Real installed CLIs, adapter registry, P0 controller, and disposable Git workspaces.
- Produces: Sanitized compatibility evidence; no production project changes.

- [ ] **Step 1: Add an opt-in smoke gate**

`test/v4/host-smoke.test.ts` must skip unless:

```text
OMNI_V4_ALLOW_MODEL_COST=1
OMNI_V4_LIVE_HOST=codex|claude|antigravity
```

Without both variables, it must skip before probing authentication or launching a host.

- [ ] **Step 2: Create a disposable test repository**

The test uses `fs.mkdtemp`, initializes Git locally, writes one text file and a minimal instruction, and requests a harmless workspace edit plus structured result. It must assert the resolved workspace is under the created temp directory and is not the Omni repository.

- [ ] **Step 3: Ask for approval host by host**

Before each live run, explain that it uses network/model quota and obtain explicit approval. Then run one host:

```powershell
$env:OMNI_V4_ALLOW_MODEL_COST='1'
$env:OMNI_V4_LIVE_HOST='codex'
npm run test:v4
```

Repeat only after separate approval with `claude`, then `antigravity`. Afterward run:

```powershell
Remove-Item Env:OMNI_V4_ALLOW_MODEL_COST -ErrorAction SilentlyContinue
Remove-Item Env:OMNI_V4_LIVE_HOST -ErrorAction SilentlyContinue
```

- [ ] **Step 4: Validate smoke evidence**

For each approved host assert:

- Safe argv contains no elevated flag.
- Only the temporary workspace changes.
- Process exit is zero.
- Native output parses without prose fallback.
- Omni result passes `StepResultSchema`.
- Artifact checksum verifies.
- P0 controller advances exactly one phase.
- Version/session and available usage/cost fields are recorded as smoke evidence; session and normalized usage are also present in `StepResult.native` when the host proves them.

- [ ] **Step 5: Promote only evidence-backed adapters**

After both gates pass on the exact recorded version, set `contractVerified: true`, `liveSmokeVerified: true`, and add the exact platform key such as `win32-x64` to `verifiedPlatforms`. Keep every other usable host experimental and state the missing evidence in `compatibility/v4/README.md`. Any later `verifiedVersion` change resets both booleans and the platform list before new evidence is collected.

- [ ] **Step 6: Update roadmap evidence**

Under each adapter milestone, record date, OS, CLI version, command, result, and status. Do not mark verification/acceptance milestones complete.

- [ ] **Step 7: Prepare the commit checkpoint**

Report suggested message `test(v4): record host compatibility smoke evidence`. Do not commit without explicit permission.

---

### Task 12: Run the full P1 acceptance gate and document handoff

**Files:**
- Modify: `compatibility/v4/README.md`
- Modify: `ROADMAP_V4.md`
- Review: all P1 source and tests

**Interfaces:**
- Consumes: Complete P0 and P1 implementation.
- Produces: P1 acceptance evidence and a clean handoff to verification/acceptance development.

- [ ] **Step 1: Run static safety scans**

Run:

```powershell
rg -n "dangerously-bypass|dangerously-skip" src/v4 test/v4
rg -n "shell:\s*true|exec\(|execSync\(" src/v4
rg -n "phase\s*=" src/v4/adapters src/v4/process src/v4/compatibility
```

Expected: dangerous flags appear only in pure elevated-mode builders and explicit tests; adapters use no shell-string execution and never mutate phase.

- [ ] **Step 2: Run all quality commands**

Run:

```powershell
npm run typecheck:v4
npm run test:v4
npm run build:v4
npm test
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 3: Verify the compatibility matrix**

For each host, ensure `compatibility/v4/README.md` states installed/verified version, required flags, contract-test result, live-smoke result or explicit absence, current status, and known limitations.

- [ ] **Step 4: Re-run P0 fault scenarios through every adapter**

Use each production adapter with a fake process runner. Assert no vendor parser can bypass artifact/evidence verification, retry policy, or protected-operation recovery.

- [ ] **Step 5: Perform final scope review**

Confirm P1 did not add cloud services, UI, deployment, automatic commit/push, provider-owned retry loops, model pricing in core, or an unverified first-class claim.

- [ ] **Step 6: Prepare the final P1 commit checkpoint**

Report suggested message `test(v4): complete P1 adapter compatibility gates`. Do not commit without explicit permission.

## P1 Handoff Notes for Lower-Capability Agents

- Dispatch exactly one numbered task per fresh agent using this template:

```text
Implement only Task <N> from plans/v4/2026-08-16-p1-agent-compatibility.md.
First verify the complete P0 gate is green. Then read this plan's Goal, Architecture, Global Constraints, stable interfaces, and Task <N> completely.
Assume only earlier-numbered P1 tasks exist. Keep all host quirks inside that host directory and use shared helpers unchanged.
Follow every checkbox in order: failing test -> observed failure -> minimal implementation -> targeted tests -> full required gates.
Do not run a live model/smoke test without explicit cost/network approval. Do not commit, push, publish, or deploy.
At the checkpoint, report: changed files; sanitized argv; exact commands and exit codes; pass/fail counts; compatibility status/evidence; suggested commit message.
If CLI help/version or a P0 contract differs, stop and return BLOCKED with exact output and the smallest host-local correction. Never weaken the shared contract suite.
```

- Execute tasks strictly in numeric order and keep one host active at a time.
- Do not modify P0 contracts to accommodate a host quirk; isolate the quirk in that host's builder or parser.
- Do not parse a success-looking substring from stdout.
- Do not catch a parser error and return success.
- Do not promote an adapter by editing the manifest alone.
- Do not run live model tests without explicit cost/network approval.
- When local CLI help differs from this plan, stop, capture exact version/help output, consult official sources where available, and update only the host-specific task.
- Do not assume resume supports the same flags as a new session; probe and test the installed CLI.
- If one host cannot satisfy the shared contract, keep it experimental rather than weakening the suite.
- At every checkpoint, report sanitized argv, changed files, tests run, and remaining compatibility evidence.

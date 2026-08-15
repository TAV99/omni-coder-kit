# Omni v4 P0 Correctness and Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fail-closed Omni v4 kernel: typed boundary contracts, deterministic state transitions, durable event and artifact storage, policy decisions, a fake adapter, recovery behavior, and fault-injection tests.

**Architecture:** V4 lives beside v3 under `src/v4` and does not import from `lib/harness`. The run controller is deterministic except at injected boundaries. Agent output enters as `unknown`, is validated once, and can authorize a forward transition only after all required artifacts and evidence validate. The append-only event log is the source of truth for replay and resume.

**Tech Stack:** Node.js 20+, TypeScript strict mode compiled as CommonJS, Zod 4 for runtime boundary validation, `node:test`, `node:assert/strict`, and the existing npm package.

## Global Constraints

- Preserve all v3 behavior and all existing tests.
- Do not import v3 harness modules into `src/v4`; copy no v3 state-machine behavior blindly.
- Use TypeScript `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`.
- Validate only at external boundaries: adapter output, disk events, disk artifacts, and user configuration.
- Use discriminated unions for every result or decision variant.
- Only a validated `succeeded` step with verified artifacts and evidence may move to the next normal phase.
- Treat `failed`, `blocked`, `cancelled`, malformed output, checksum mismatch, and missing evidence as non-success.
- Treat interrupted external or otherwise protected side effects as blocked on resume; never replay them automatically.
- Keep `.omni/v4/runs/<runId>/events.ndjson` append-only.
- Never infer state from console prose.
- Never commit, push, tag, publish, or deploy unless the user gives explicit permission in the active session.
- At each commit checkpoint, report the suggested commit message and wait if commit permission has not been granted.

## Definition of P0 Done

- `npm run typecheck:v4` passes.
- `npm run test:v4` passes.
- `npm test` passes, including all v3 tests.
- `npm run build:v4` produces CommonJS output under `dist-v4/src/v4`.
- Every allowed and forbidden phase transition has a unit test.
- Malformed or unsuccessful adapter output cannot advance a run.
- A success result with missing, stale, or modified artifacts cannot advance a run.
- Event replay produces the same state as uninterrupted execution.
- An interrupted protected operation resumes as `blocked`, without executing the adapter again.
- Duplicate event IDs and sequence conflicts fail visibly.

## Locked File Structure

```text
architecture/v4/decisions/
  0001-typescript-node20.md
  0002-event-log-source-of-truth.md
  0003-fail-closed-boundaries.md
scripts/
  run-v4-tests.cjs
src/v4/
  contracts/
    ids.ts
    run.ts
    evidence.ts
    artifact.ts
    step-result.ts
    adapter.ts
    policy.ts
    event.ts
    index.ts
  core/
    transitions.ts
    reducer.ts
    controller.ts
    recovery.ts
  policy/
    default-policy.ts
  storage/
    paths.ts
    event-store.ts
    artifact-store.ts
  testing/
    fake-adapter.ts
    fault-scenarios.ts
  index.ts
test/v4/
  contracts.test.ts
  transitions.test.ts
  policy.test.ts
  event-store.test.ts
  artifact-store.test.ts
  fake-adapter.test.ts
  controller.test.ts
  recovery.test.ts
  fault-injection.test.ts
tsconfig.v4.json
```

## Stable Interfaces Produced by P0

P1 agents must consume these exports without renaming them:

```ts
export type RunId = string & { readonly __brand: "RunId" };
export type StepId = string & { readonly __brand: "StepId" };
export type EventId = string & { readonly __brand: "EventId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export type RunPhase =
  | "INTAKE"
  | "PLAN"
  | "EXECUTE"
  | "VERIFY"
  | "FIX"
  | "ACCEPT"
  | "REWORK"
  | "DOCUMENT"
  | "READY"
  | "BLOCKED"
  | "CANCELLED";

export type Capability =
  | "workspace.read"
  | "workspace.write"
  | "shell"
  | "structured-output"
  | "streaming"
  | "cancel"
  | "native-resume"
  | "usage"
  | "subagents";

export type SideEffectClass = "read-only" | "workspace-write" | "external";

export interface AgentAdapter {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<AdapterProbe>;
  execute(request: StepRequest, context: AdapterContext): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}

export interface EventStore {
  append(event: RunEvent, expectedSequence: number): Promise<void>;
  read(runId: RunId): Promise<readonly RunEvent[]>;
}

export interface ArtifactStore {
  record(input: ArtifactRecordInput): Promise<ArtifactRecord>;
  verify(record: ArtifactRecord): Promise<ArtifactVerification>;
}

export interface Policy {
  evaluatePreflight(input: PreflightInput): PolicyDecision;
  decideFailure(input: FailureInput): PolicyDecision;
  decideResume(input: ResumeInput): PolicyDecision;
}
```

---

### Task 1: Add the isolated TypeScript v4 toolchain

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` through `npm install`
- Create: `tsconfig.v4.json`
- Create: `scripts/run-v4-tests.cjs`
- Test: `test/v4/contracts.test.ts`

**Interfaces:**
- Consumes: Existing npm scripts and CommonJS package layout.
- Produces: `build:v4`, `typecheck:v4`, and `test:v4` commands; no runtime v4 API yet.

- [ ] **Step 1: Create a deliberately failing v4 smoke test**

Create `test/v4/contracts.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { V4_SCHEMA_VERSION } from "../../src/v4/index";

test("v4 exports schema version 1", () => {
  assert.equal(V4_SCHEMA_VERSION, 1);
});
```

- [ ] **Step 2: Add TypeScript dependencies and scripts**

Run:

```powershell
npm install zod@^4.0.0
npm install --save-dev typescript@^5.9.0 tsx@^4.20.0 @types/node@^20.0.0
```

Update `package.json` so these scripts exist without deleting the existing `test` command:

```json
{
  "scripts": {
    "test": "node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js && npm run test:v4",
    "build:v4": "tsc -p tsconfig.v4.json",
    "typecheck:v4": "tsc -p tsconfig.v4.json --noEmit",
    "test:v4": "node scripts/run-v4-tests.cjs"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

Do not remove existing dependencies, metadata, or scripts not shown above.

- [ ] **Step 3: Add strict compiler configuration**

Create `tsconfig.v4.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "rootDir": ".",
    "outDir": "dist-v4",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/v4/**/*.ts", "test/v4/**/*.ts"],
  "exclude": ["node_modules", "dist-v4"]
}
```

- [ ] **Step 4: Add a cross-platform test launcher**

Create `scripts/run-v4-tests.cjs`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test", "v4");
const files = fs.existsSync(testDir)
  ? fs.readdirSync(testDir)
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => path.join(testDir, name))
  : [];

if (files.length === 0) {
  console.error("No v4 test files found in test/v4");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { cwd: root, stdio: "inherit" },
);

process.exit(result.status ?? 1);
```

- [ ] **Step 5: Verify the smoke test fails for the intended reason**

Run:

```powershell
npm run test:v4
```

Expected: FAIL because `src/v4/index.ts` does not exist.

- [ ] **Step 6: Add the smallest v4 entry point**

Create `src/v4/index.ts`:

```ts
export const V4_SCHEMA_VERSION = 1 as const;
```

- [ ] **Step 7: Verify toolchain and legacy compatibility**

Run:

```powershell
npm run typecheck:v4
npm run test:v4
npm run build:v4
npm test
```

Expected: all commands exit `0`; existing v3 tests still pass.

- [ ] **Step 8: Prepare the commit checkpoint**

Run `git diff --check` and report suggested message `chore(v4): add isolated TypeScript toolchain`. Do not commit without explicit permission.

---

### Task 2: Record the irreversible architecture decisions

**Files:**
- Create: `architecture/v4/decisions/0001-typescript-node20.md`
- Create: `architecture/v4/decisions/0002-event-log-source-of-truth.md`
- Create: `architecture/v4/decisions/0003-fail-closed-boundaries.md`

**Interfaces:**
- Consumes: `ROADMAP_V4.md` sections 3-6.
- Produces: Stable rationale that later agents must cite when changing core contracts.

- [ ] **Step 1: Write ADR 0001**

It must contain these decisions:

```markdown
# ADR-0001: Use TypeScript strict mode on Node.js 20 for Omni v4

## Status
Accepted

## Context
V3 is CommonJS JavaScript. V4 introduces persistent schemas and cross-provider contracts where invalid variants must be rejected before state transitions.

## Decision
Build v4 in `src/v4` with TypeScript strict mode, CommonJS output, Node.js 20 minimum, Zod validation at external boundaries, and no imports from the v3 harness.

## Alternatives Considered
- Continue JavaScript with JSDoc: rejected because discriminated contracts and refactors remain easier to misuse.
- Convert all v3 code immediately: rejected because it expands rewrite risk and removes the stable fallback.
- ESM-only output: deferred because the existing package is CommonJS and v4 must coexist during development.

## Consequences
- The package Node floor becomes 20.
- V4 has an explicit build step.
- V3 remains runnable while v4 is incomplete.
```

- [ ] **Step 2: Write ADR 0002**

State that `.omni/v4/runs/<runId>/events.ndjson` is append-only, replay is authoritative, cached state is disposable, every event has a monotonic sequence, and conflicting appends fail instead of overwriting.

- [ ] **Step 3: Write ADR 0003**

State that adapter output is untrusted, only schema-valid success plus verified artifacts/evidence advances, skipped/inconclusive is not passed, and elevated permissions are never selected implicitly.

- [ ] **Step 4: Review the ADRs against the roadmap**

Run:

```powershell
Select-String -Path architecture\v4\decisions\*.md -Pattern 'Accepted|Alternatives Considered|Consequences'
```

Expected: each of the three files contains all required headings.

- [ ] **Step 5: Prepare the commit checkpoint**

Run `git diff --check` and report suggested message `docs(v4): record kernel architecture decisions`. Do not commit without explicit permission.

---

### Task 3: Define branded IDs, phases, evidence, artifacts, and step results

**Files:**
- Create: `src/v4/contracts/ids.ts`
- Create: `src/v4/contracts/run.ts`
- Create: `src/v4/contracts/evidence.ts`
- Create: `src/v4/contracts/artifact.ts`
- Create: `src/v4/contracts/step-result.ts`
- Create: `src/v4/contracts/index.ts`
- Modify: `src/v4/index.ts`
- Test: `test/v4/contracts.test.ts`

**Interfaces:**
- Consumes: Zod 4.
- Produces: `RunId`, `StepId`, `EventId`, `ArtifactId`, `RunPhase`, `Capability`, `Evidence`, `ArtifactClaim`, `ArtifactRecord`, `StepResult`, and their boundary schemas.

- [ ] **Step 1: Extend failing tests for all result variants**

Add tests that assert:

```ts
import {
  StepResultSchema,
  asArtifactId,
  asStepId,
  type StepResult,
} from "../../src/v4/contracts";

test("StepResultSchema accepts a complete success", () => {
  const result = StepResultSchema.parse({
    status: "succeeded",
    executionId: "exec-1",
    summary: "wrote one file",
    artifacts: [],
    evidence: [],
  }) satisfies StepResult;
  assert.equal(result.status, "succeeded");
});

test("StepResultSchema rejects prose-only success", () => {
  assert.throws(() => StepResultSchema.parse({ ok: true, summary: "done" }));
});

test("StepResultSchema rejects failure without a stable signature", () => {
  assert.throws(() => StepResultSchema.parse({
    status: "failed",
    executionId: "exec-1",
    failure: { code: "CLI_EXIT", message: "failed", retryable: true },
  }));
});
```

- [ ] **Step 2: Implement IDs and run enums**

`ids.ts` must export branded string types and non-empty conversion functions. `run.ts` must export the exact `RunPhase`, `Capability`, and `SideEffectClass` unions locked above plus:

```ts
export interface RunState {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly sequence: number;
  readonly attempt: number;
  readonly sameFailureCount: number;
  readonly lastFailureSignature?: string;
  readonly inFlight?: {
    readonly stepId: StepId;
    readonly operationId: string;
    readonly sideEffect: SideEffectClass;
  };
  readonly startedAt: string;
  readonly updatedAt: string;
}
```

- [ ] **Step 3: Implement evidence and artifact contracts**

Use these exact public shapes:

```ts
export interface Evidence {
  readonly schemaVersion: 1;
  readonly kind: "command" | "artifact" | "agent-judgement" | "policy";
  readonly producerStepId: StepId;
  readonly method: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly artifactIds: readonly ArtifactId[];
  readonly summary: string;
  readonly command?: readonly string[];
  readonly exitCode?: number;
}

export interface ArtifactClaim {
  readonly artifactId: ArtifactId;
  readonly kind: "file" | "report" | "manifest";
  readonly relativePath: string;
}

export interface ArtifactRecord {
  readonly schemaVersion: 1;
  readonly artifactId: ArtifactId;
  readonly runId: RunId;
  readonly producerStepId: StepId;
  readonly kind: "file" | "report" | "manifest";
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly recordedAt: string;
}
```

`ArtifactClaim` is the only artifact shape an adapter may return. It is an untrusted claim about a workspace-relative path; it must not contain `runId`, `producerStepId`, checksum, size, or timestamps. The controller and `ArtifactStore` are authoritative for those fields.

Reject absolute paths and `..` segments in claims and records. Reject negative durations, negative sizes, and malformed SHA-256 strings at the relevant schema boundaries.

- [ ] **Step 4: Implement the step-result discriminated union**

Use the exact variants:

```ts
export type StepResult =
  | {
      readonly status: "succeeded";
      readonly executionId: string;
      readonly summary: string;
      readonly artifacts: readonly ArtifactClaim[];
      readonly evidence: readonly Evidence[];
      readonly nativeSessionId?: string;
    }
  | {
      readonly status: "failed";
      readonly executionId: string;
      readonly failure: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly signature: string;
      };
    }
  | {
      readonly status: "blocked";
      readonly executionId: string;
      readonly reason: string;
      readonly requiredAction: string;
    }
  | {
      readonly status: "cancelled";
      readonly executionId: string;
      readonly reason: string;
    };
```

Create matching strict Zod schemas. Unknown fields must be rejected.

- [ ] **Step 5: Export the contract surface**

`src/v4/contracts/index.ts` exports only public types, schemas, and ID conversion functions. `src/v4/index.ts` re-exports `./contracts` and `V4_SCHEMA_VERSION`.

- [ ] **Step 6: Verify boundaries and type narrowing**

Run:

```powershell
npm run typecheck:v4
npm run test:v4
```

Expected: all contract tests pass; TypeScript switch statements can narrow each `StepResult` variant without casts.

- [ ] **Step 7: Prepare the commit checkpoint**

Run `git diff --check` and report suggested message `feat(v4): define fail-closed run contracts`. Do not commit without explicit permission.

---

### Task 4: Define adapter, policy, and event contracts

**Files:**
- Create: `src/v4/contracts/adapter.ts`
- Create: `src/v4/contracts/policy.ts`
- Create: `src/v4/contracts/event.ts`
- Modify: `src/v4/contracts/index.ts`
- Test: `test/v4/contracts.test.ts`

**Interfaces:**
- Consumes: Contract types from Task 3.
- Produces: Stable interfaces consumed by every remaining P0 and P1 task.

- [ ] **Step 1: Write compile-time and runtime contract tests**

Add test fixtures for a successful `AdapterProbe`, a `step.started` event, and rejection of an event with a negative sequence or unknown event type.

- [ ] **Step 2: Implement adapter contracts**

Use these exact shapes:

```ts
export interface AdapterProbe {
  readonly available: boolean;
  readonly adapterId: string;
  readonly binary?: string;
  readonly version?: string;
  readonly capabilities: readonly Capability[];
  readonly diagnostics: readonly string[];
}

export interface StepRequest {
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly phase: RunPhase;
  readonly operationId: string;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly requiredCapabilities: readonly Capability[];
  readonly sideEffect: SideEffectClass;
  readonly timeoutMs: number;
}

export interface AdapterContext {
  readonly signal: AbortSignal;
  readonly elevatedPermissions: boolean;
  readonly resumeSessionId?: string;
}

export interface AgentAdapter {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<AdapterProbe>;
  execute(request: StepRequest, context: AdapterContext): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}
```

- [ ] **Step 3: Implement policy contracts**

Use a single decision union:

```ts
export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "retry"; readonly delayMs: number }
  | { readonly kind: "block"; readonly reason: string; readonly requiredAction: string }
  | { readonly kind: "deny"; readonly reason: string };
```

Define `PreflightInput`, `FailureInput`, `ResumeInput`, and the `Policy` interface shown in the locked surface. `ResumeInput` must include the in-flight side-effect class.

- [ ] **Step 4: Implement event contracts**

Use a strict discriminated union with these event types:

```ts
export type RunEventType =
  | "run.created"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "step.blocked"
  | "step.cancelled"
  | "step.interrupted"
  | "artifact.recorded"
  | "policy.denied"
  | "run.transitioned"
  | "run.blocked"
  | "run.cancelled";
```

Every `RunEvent` contains `schemaVersion`, `eventId`, `runId`, `sequence`, `at`, `type`, and type-specific `payload`. Use Zod schemas for disk validation.

- [ ] **Step 5: Verify no `any` leaks through public contracts**

Run:

```powershell
npm run typecheck:v4
rg -n "\bany\b" src/v4/contracts test/v4/contracts.test.ts
```

Expected: typecheck passes; `rg` reports no TypeScript `any` usage in the contract surface.

- [ ] **Step 6: Prepare the commit checkpoint**

Report suggested message `feat(v4): define adapter policy and event interfaces`. Do not commit without explicit permission.

---

### Task 5: Implement the deterministic transition table and event reducer

**Files:**
- Create: `src/v4/core/transitions.ts`
- Create: `src/v4/core/reducer.ts`
- Test: `test/v4/transitions.test.ts`

**Interfaces:**
- Consumes: `RunPhase`, `RunEvent`, and `RunState`.
- Produces: `nextPhaseOnSuccess(phase)`, `isAllowedTransition(from, to)`, `createInitialState(input)`, and `reduceEvent(state, event)`.

- [ ] **Step 1: Write table-driven transition tests**

Cover this complete normal-success table:

```ts
const successTransitions = [
  ["INTAKE", "PLAN"],
  ["PLAN", "EXECUTE"],
  ["EXECUTE", "VERIFY"],
  ["VERIFY", "ACCEPT"],
  ["FIX", "VERIFY"],
  ["ACCEPT", "DOCUMENT"],
  ["REWORK", "EXECUTE"],
  ["DOCUMENT", "READY"],
] as const;
```

Also assert that `READY`, `BLOCKED`, and `CANCELLED` have no normal-success transition, and that every unlisted pair is rejected.

- [ ] **Step 2: Implement the explicit transition map**

Do not derive transitions from enum order. `nextPhaseOnSuccess` throws `TransitionError` when no normal transition exists.

- [ ] **Step 3: Write reducer tests for every event type**

At minimum assert:

- `run.created` creates sequence `0` in `INTAKE`.
- `step.started` sets `inFlight` without changing phase.
- `step.failed` clears `inFlight`, increments `attempt`, and updates the failure signature/count.
- `step.succeeded` clears `inFlight` but does not change phase.
- Only `run.transitioned` changes phase.
- A non-consecutive sequence throws `EventSequenceError`.
- A transition not allowed by the table throws `TransitionError`.
- Events after `READY` are rejected except a duplicate-detection path handled by storage.

- [ ] **Step 4: Implement the pure reducer**

The reducer must not read time, disk, environment variables, or random values. It trusts only an already validated event and returns a new immutable state.

- [ ] **Step 5: Verify exhaustive tests**

Run:

```powershell
npm run test:v4
npm run typecheck:v4
```

Expected: every transition pair is covered by the table-driven suite; all commands exit `0`.

- [ ] **Step 6: Prepare the commit checkpoint**

Report suggested message `feat(v4): add deterministic run reducer`. Do not commit without explicit permission.

---

### Task 6: Implement the default safety policy

**Files:**
- Create: `src/v4/policy/default-policy.ts`
- Test: `test/v4/policy.test.ts`

**Interfaces:**
- Consumes: `Policy`, policy inputs, and `Capability`.
- Produces: `createDefaultPolicy(config?)` implementing the stable `Policy` interface.

- [ ] **Step 1: Write policy tests before implementation**

Assert all of these rules:

- Missing required capability returns `deny`.
- Elevated permissions return `deny` unless `allowElevatedPermissions` is exactly `true`.
- A retryable first failure returns `retry` with delay `0`.
- A retryable second identical failure returns `block`.
- A non-retryable failure returns `block` immediately.
- Interrupted `read-only` work returns `retry`.
- Interrupted `workspace-write` or `external` work returns `block`.
- Unknown optional config fields are rejected by the config schema.

- [ ] **Step 2: Implement locked defaults**

Use these defaults:

```ts
export interface DefaultPolicyConfig {
  readonly allowElevatedPermissions: boolean;
  readonly maxRetriesPerStep: number;
  readonly maxSameFailureCount: number;
  readonly retryDelayMs: number;
}

export const DEFAULT_POLICY_CONFIG: DefaultPolicyConfig = {
  allowElevatedPermissions: false,
  maxRetriesPerStep: 2,
  maxSameFailureCount: 2,
  retryDelayMs: 0,
};
```

Reject negative or non-integer limits.

- [ ] **Step 3: Verify fail-closed defaults**

Run `npm run test:v4`.

Expected: policy tests prove that omitted configuration never enables elevated permissions or interrupted write replay.

- [ ] **Step 4: Prepare the commit checkpoint**

Report suggested message `feat(v4): enforce fail-closed default policy`. Do not commit without explicit permission.

---

### Task 7: Implement append-only event storage and replay

**Files:**
- Create: `src/v4/storage/paths.ts`
- Create: `src/v4/storage/event-store.ts`
- Test: `test/v4/event-store.test.ts`

**Interfaces:**
- Consumes: `RunEventSchema`, `RunId`, and `EventStore`.
- Produces: `FileEventStore` and `replayRun(events)`.

- [ ] **Step 1: Write filesystem tests in temporary directories**

Cover:

- First append creates `.omni/v4/runs/<runId>/events.ndjson`.
- Appended JSON is one compact object per line ending in `\n`.
- `read` validates every line with `RunEventSchema`.
- Expected sequence mismatch rejects before writing.
- Duplicate `eventId` rejects.
- A malformed or truncated final line raises `CorruptEventLogError`.
- Two sequential appends replay to the same state as direct reduction.

- [ ] **Step 2: Implement path containment**

`resolveRunDir(projectDir, runId)` must resolve an absolute directory inside `<projectDir>/.omni/v4/runs`. Reject path separators in branded IDs before filesystem use.

- [ ] **Step 3: Implement durable append**

Open with append mode, write one buffer, call `filehandle.sync()`, then close in `finally`. In this single-process P0 implementation, use the expected sequence as optimistic concurrency control. Do not add a lock service.

- [ ] **Step 4: Implement validated read and replay**

`read` returns events sorted only by their stored order; it must not sort corrupt input into correctness. Validate sequence `0..n` and event ID uniqueness.

- [ ] **Step 5: Verify storage tests**

Run:

```powershell
npm run test:v4
npm run typecheck:v4
```

Expected: all storage and reducer tests pass on Windows.

- [ ] **Step 6: Prepare the commit checkpoint**

Report suggested message `feat(v4): persist append-only run events`. Do not commit without explicit permission.

---

### Task 8: Implement checksum-backed artifact storage

**Files:**
- Create: `src/v4/storage/artifact-store.ts`
- Test: `test/v4/artifact-store.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore`, `ArtifactClaim`, `ArtifactRecord`, IDs, and workspace paths.
- Produces: `FileArtifactStore`, `ArtifactRecordInput`, and `ArtifactVerification`.

- [ ] **Step 1: Write artifact security tests**

Cover:

- Recording a real file computes lower-case SHA-256 and size.
- Verification passes when content is unchanged.
- Verification returns `{ valid: false, reason: "checksum-mismatch" }` after modification.
- Verification returns `missing` after deletion.
- Absolute paths, `..`, symlink escape, and paths outside the workspace are rejected.
- The store ignores no caller-supplied checksum or producer metadata because `ArtifactClaim` cannot carry those fields.

- [ ] **Step 2: Define store-specific inputs and outputs**

```ts
export interface ArtifactRecordInput {
  readonly runId: RunId;
  readonly producerStepId: StepId;
  readonly claim: ArtifactClaim;
  readonly recordedAt: string;
}

export type ArtifactVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "missing" | "checksum-mismatch" | "path-escape" };
```

- [ ] **Step 3: Implement recording and verification**

Use `crypto.createHash("sha256")`. Resolve the real path of both workspace and target before accepting the file. Never store file content inside the event log.

- [ ] **Step 4: Verify artifact tests**

Run `npm run test:v4` and `npm run typecheck:v4`.

Expected: all artifact boundary and symlink escape tests pass.

- [ ] **Step 5: Prepare the commit checkpoint**

Report suggested message `feat(v4): verify artifacts by checksum`. Do not commit without explicit permission.

---

### Task 9: Implement the deterministic fake adapter

**Files:**
- Create: `src/v4/testing/fake-adapter.ts`
- Test: `test/v4/fake-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AdapterProbe`, `StepRequest`, and `AdapterContext`.
- Produces: `FakeAdapter` with a queued script of `unknown` results or thrown errors.

- [ ] **Step 1: Write behavior tests**

Assert:

- `probe` returns the configured availability and capabilities.
- Each `execute` call consumes exactly one queued outcome.
- Outcomes may be valid results, malformed objects, thrown errors, or an abort wait.
- Calls record the exact request and whether elevated permissions were requested.
- `cancel(executionId)` records the ID.
- Executing with no queued outcome throws a clear test-fixture error.

- [ ] **Step 2: Implement the fake adapter API**

Use this constructor surface:

```ts
export type FakeOutcome =
  | { readonly kind: "return"; readonly value: unknown }
  | { readonly kind: "throw"; readonly error: Error }
  | { readonly kind: "wait-for-abort" };

export interface FakeAdapterOptions {
  readonly id?: string;
  readonly available?: boolean;
  readonly capabilities?: readonly Capability[];
  readonly outcomes: readonly FakeOutcome[];
}

export class FakeAdapter implements AgentAdapter {
  readonly calls: Array<{ request: StepRequest; context: AdapterContext }>;
  readonly cancelledExecutionIds: string[];
  // Implement AgentAdapter methods.
}
```

- [ ] **Step 3: Verify deterministic execution**

Run `npm run test:v4` twice.

Expected: identical pass count and no timing-dependent failure.

- [ ] **Step 4: Prepare the commit checkpoint**

Report suggested message `test(v4): add deterministic fake adapter`. Do not commit without explicit permission.

---

### Task 10: Implement the fail-closed run controller

**Files:**
- Create: `src/v4/core/controller.ts`
- Modify: `src/v4/index.ts`
- Test: `test/v4/controller.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `Policy`, `EventStore`, `ArtifactStore`, schemas, reducer, and transition table.
- Produces: `RunController.start`, `RunController.executeNext`, and `RunController.getState`.

- [ ] **Step 1: Write controller tests for the success path**

The test must create a temporary workspace, real artifact file, fake success result, and assert this exact durable event order:

```text
run.created
step.started
artifact.recorded
step.succeeded
run.transitioned
```

Assert phase moves from `INTAKE` to `PLAN` only after checksum verification.

- [ ] **Step 2: Write controller tests for every non-success path**

Assert no `run.transitioned` event and no phase change for:

- Adapter throws.
- Adapter returns malformed output.
- Adapter returns `failed`.
- Adapter returns `blocked`.
- Adapter returns `cancelled`.
- Adapter reports success but artifact is missing.
- Artifact checksum is stale.
- Evidence points to an artifact absent from the success result.
- Evidence has the wrong `producerStepId`.
- Adapter probe lacks a required capability.
- Elevated permissions are requested but policy denies them.

- [ ] **Step 3: Implement constructor and public methods**

```ts
export interface RunControllerDeps {
  readonly adapter: AgentAdapter;
  readonly policy: Policy;
  readonly events: EventStore;
  readonly artifacts: ArtifactStore;
  readonly now: () => string;
  readonly newEventId: () => EventId;
}

export class RunController {
  constructor(deps: RunControllerDeps);
  start(input: { runId: RunId; startedAt?: string }): Promise<RunState>;
  getState(runId: RunId): Promise<RunState>;
  executeNext(
    request: StepRequest,
    options?: { elevatedPermissions?: boolean; resumeSessionId?: string },
  ): Promise<RunState>;
}
```

- [ ] **Step 4: Implement the exact execution order**

1. Replay current state.
2. Require `request.phase === state.phase`.
3. Probe adapter.
4. Ask policy to evaluate availability, capabilities, and permissions.
5. Append `step.started` before invoking the adapter.
6. Execute with an `AbortController` timeout.
7. Parse returned `unknown` through `StepResultSchema`.
8. On success, validate every `ArtifactClaim`, then call `artifacts.record({ runId: request.runId, producerStepId: request.stepId, claim, recordedAt: now() })` so trusted run/producer/checksum/size metadata is created outside the adapter.
9. Immediately call `artifacts.verify(record)` for every returned record; verify each evidence item has `producerStepId === request.stepId` and references only artifact IDs recorded from this success result.
10. Append one `artifact.recorded` event per validated `ArtifactRecord`.
11. Append the terminal step event.
12. Append `run.transitioned` only for valid success.
13. Replay and return state.

Convert thrown errors and timeouts to structured `step.failed` events with stable signatures; do not allow them to escape after the start event is durable unless event persistence itself fails.

- [ ] **Step 5: Verify no direct phase mutation exists**

Run:

```powershell
rg -n "phase\s*=" src/v4/core/controller.ts
npm run test:v4
npm run typecheck:v4
```

Expected: controller never assigns phase directly; tests and typecheck pass.

- [ ] **Step 6: Prepare the commit checkpoint**

Report suggested message `feat(v4): enforce evidence-gated execution`. Do not commit without explicit permission.

---

### Task 11: Implement replay recovery and protected-operation handling

**Files:**
- Create: `src/v4/core/recovery.ts`
- Modify: `src/v4/core/controller.ts`
- Test: `test/v4/recovery.test.ts`

**Interfaces:**
- Consumes: `RunState.inFlight`, `Policy.decideResume`, and append-only events.
- Produces: `recoverRun(controllerDeps, runId)` and `RunController.resume(runId)`.

- [ ] **Step 1: Write crash-recovery tests**

Create logs ending after `step.started` for each side-effect class and assert:

- `read-only`: policy permits retry and recovery appends `step.interrupted`; returned directive is `rerun` with the same operation ID.
- `workspace-write`: recovery appends `run.blocked`; adapter is not called.
- `external`: recovery appends `run.blocked`; adapter is not called.
- Complete success followed by transition resumes at the new phase with no new event.
- Corrupt log rejects recovery and writes nothing further.

- [ ] **Step 2: Define the resume result**

```ts
export type ResumeResult =
  | { readonly kind: "continue"; readonly state: RunState }
  | { readonly kind: "rerun"; readonly state: RunState; readonly operationId: string }
  | { readonly kind: "blocked"; readonly state: RunState; readonly reason: string };
```

- [ ] **Step 3: Implement recovery without hidden execution**

`resume` may append recovery events, but it must never invoke `adapter.execute`. A caller must explicitly call `executeNext` after receiving `rerun`.

- [ ] **Step 4: Verify protected side effects are not duplicated**

Run `npm run test:v4`.

Expected: fake adapter call count stays `0` in interrupted workspace-write and external tests.

- [ ] **Step 5: Prepare the commit checkpoint**

Report suggested message `feat(v4): recover interrupted runs safely`. Do not commit without explicit permission.

---

### Task 12: Add reusable fault scenarios and the P0 acceptance suite

**Files:**
- Create: `src/v4/testing/fault-scenarios.ts`
- Create: `test/v4/fault-injection.test.ts`
- Modify: `src/v4/index.ts`
- Modify: `ROADMAP_V4.md`

**Interfaces:**
- Consumes: All P0 public interfaces.
- Produces: Reusable scenario builders for P1 adapter tests and recorded P0 exit-gate evidence.

- [ ] **Step 1: Implement named fault builders**

Export deterministic builders for:

```ts
export const faultScenarios = {
  providerThrow,
  providerTimeout,
  malformedSuccess,
  missingArtifact,
  modifiedArtifact,
  truncatedEventLog,
  duplicateEvent,
  interruptedReadOnly,
  interruptedWorkspaceWrite,
  interruptedExternal,
} as const;
```

Each builder returns a temporary project fixture plus expected terminal phase and expected event types.

- [ ] **Step 2: Write a table-driven acceptance test**

For every scenario assert:

- Expected terminal phase.
- Whether a transition event is allowed.
- Adapter call count.
- Event log remains parseable unless corruption is the scenario.
- No scenario reports `READY`.

- [ ] **Step 3: Export only the intended v4 surface**

`src/v4/index.ts` must export contracts, controller, default policy, stores, and testing helpers only under a clearly marked testing export. Do not export internal transition maps as mutable objects.

- [ ] **Step 4: Run the complete P0 gate**

Run:

```powershell
npm run typecheck:v4
npm run test:v4
npm run build:v4
npm test
git diff --check
```

Expected: all exit `0`.

- [ ] **Step 5: Update roadmap evidence without marking later milestones complete**

Under Milestone 1 in `ROADMAP_V4.md`, add a dated evidence note containing the exact P0 commands, pass counts, and any platform limitation. Do not claim Codex, Claude Code, or Antigravity support yet.

- [ ] **Step 6: Perform final scope review**

Confirm there is no production adapter, dashboard, cloud service, deployment, automatic commit, or v3 refactor in the P0 diff.

- [ ] **Step 7: Prepare the final P0 commit checkpoint**

Report suggested message `test(v4): prove P0 correctness and recovery gates`. Do not commit without explicit permission.

## P0 Handoff Notes for Lower-Capability Agents

- Execute tasks strictly in numeric order.
- Do not start P1 until Task 12 passes completely.
- If an interface in this plan cannot compile as written, stop and report the exact conflict; do not rename it locally.
- Do not weaken a failing assertion to make the suite green.
- Do not convert `unknown` adapter output with a TypeScript cast; parse it with `StepResultSchema`.
- Do not add retry loops inside adapters; retry is a policy/controller decision.
- Do not cache state as a new source of truth; replay the event log.
- If filesystem durability behavior differs by operating system, add an explicit platform test and document the limitation.
- At every checkpoint, show changed files, commands run, and exact failures before asking for the next task.

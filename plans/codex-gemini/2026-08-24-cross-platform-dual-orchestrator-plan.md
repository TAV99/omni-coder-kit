# Cross-Platform Codex–Agy Dual Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generated PowerShell Dual workflow with a maintained, resumable, fail-closed `omni dual` Node.js orchestrator that runs from Windows CMD/PowerShell, Linux, and macOS.

**Architecture:** CommonJS modules under `lib/dual/` separate contracts, workspace enforcement, immutable artifacts, event-sourced state, Agy transport, and orchestration. The public `omni dual` CLI drives these modules; Agy is always spawned with an argv array and `shell: false`, while the old PowerShell entry point becomes a temporary delegation shim.

**Tech Stack:** Node.js 20+, CommonJS, Commander, Zod 4, Node test runner, Git CLI, Antigravity `agy` 1.1.19+.

## Global Constraints

- Supported hosts: Windows CMD, Windows PowerShell, Linux shells, and macOS shells.
- Do not require PowerShell on Linux or macOS.
- Worker model is exactly `gemini-3.7-flash-high` with effort `high`.
- Every `codex-agy` worker phase includes `--dangerously-skip-permissions`; do not modify global Agy configuration.
- Every child process uses argv plus `shell: false`; never embed raw request/spec/evidence JSON in argv.
- Codex owns architecture, deterministic routing authority, final QC, and all commit/push decisions.
- Gemini receives at most three allowed files and no architecture, security, migration, cross-module, or ambiguous task.
- Fail closed on non-zero worker exit, invalid state, stale base commit, invalid schema, workspace escape, out-of-scope diff, or review mutation.
- Normal tests use fake Agy only. For bootstrap implementation delegation (Tasks 5-9), live Agy calls with `gemini-3.7-flash-high` were explicitly authorized by the user, while automated tests/CI remain fake-only and credential-free.
- Preserve existing uncommitted changes in `bin/omni.js`, `lib/commands/init.js`, `lib/commands/init-setup.js`, and `test/init.test.js`; never reset or overwrite them. Before Task 7, review and either separately commit the approved advanced-setup fix with user authority or integrate it visibly without mixing its assertions into unrelated commits.
- Do not commit, push, deploy, stash, reset, or revert unless the user grants that specific authority during execution. Commit commands below are gated checkpoints, not standing authorization.

---

## Pre-execution Workspace Gate

- [ ] **Step 1: Confirm repository and dirty-tree boundaries.**

Run:

```powershell
git branch --show-current
git status --short
git diff -- lib/commands/init.js lib/commands/init-setup.js test/init.test.js
git diff --ignore-space-at-eol --exit-code -- bin/omni.js
```

Expected: branch `v4`; the three advanced-setup files remain visible; `bin/omni.js` has no semantic diff under `--ignore-space-at-eol`.

- [ ] **Step 2: Record the implementation boundary.**

The executor's first progress update must state that existing advanced-setup changes are preserved, `bin/omni.js` is a line-ending-only workspace change, automated CI/tests use fake Agy only, and live Agy calls are restricted to user-authorized bootstrap implementation.

---

### Task 1: Define canonical Dual contracts

**Files:**
- Create: `lib/dual/contracts.js`
- Create: `test/dual-contracts.test.js`
- Retain as packaged compatibility resources: `templates/codex-gemini/schemas/*.schema.json`

**Interfaces:**
- Produces: `TaskIdSchema`, `ContextSchema`, `SpecSchema`, `RouteSchema`, `EvidenceSchema`, `ReviewSchema`, `EventSchema`, `AttemptMetaSchema`.
- Produces: `parseContract(schema, value, label)` returning parsed data or throwing `DualContractError` with stable code `DUAL_CONTRACT_INVALID`.
- Produces: `toDraft7Schema(schema, id)` returning a strict draft-07 JSON schema for Agy.
- Consumes: Zod 4 already present in `package.json`.

- [ ] **Step 1: Write failing contract tests.**

Create tests with these exact cases:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  TaskIdSchema, SpecSchema, EvidenceSchema, ReviewSchema,
  parseContract, toDraft7Schema,
} = require('../lib/dual/contracts');

describe('dual contracts', () => {
  it('accepts the approved typed spec', () => {
    const input = {
      schema_version: 1,
      task_id: 'AI4T-002',
      expected_base_commit: 'a'.repeat(40),
      goal: 'Build the conversion structure',
      allowed_files: ['index.html', 'styles.css', 'tests/landing-page.test.mjs'],
      deny_patterns: ['**/.env*'],
      validation_commands: [{ program: 'npm', args: ['test'], cwd: '.' }],
      risk_flags: [],
      permission_authority: 'dual-init-dangerous-auto-v1',
    };
    const spec = parseContract(SpecSchema, input, 'spec');
    assert.equal(spec.allowed_files.length, 3);
    assert.equal(SpecSchema.safeParse({ ...input, validation_commands: ['npm test'] }).success, false);
  });

  it('rejects unsafe IDs and extra fields while allowing Codex-owned larger specs', () => {
    assert.equal(TaskIdSchema.safeParse('../escape').success, false);
    const base = {
      schema_version: 1, task_id: 'X', expected_base_commit: 'b'.repeat(40), goal: 'x',
      allowed_files: ['a', 'b', 'c', 'd'], deny_patterns: [],
      validation_commands: [{ program: 'node', args: ['--test'], cwd: '.' }],
      risk_flags: [], permission_authority: 'dual-init-dangerous-auto-v1',
    };
    assert.equal(SpecSchema.safeParse(base).success, true);
    assert.equal(SpecSchema.safeParse({ ...base, allowed_files: ['a'], surprise: true }).success, false);
  });

  it('emits strict draft-07 schemas and rejects invalid worker enums', () => {
    const jsonSchema = toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1');
    assert.equal(jsonSchema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(jsonSchema.additionalProperties, false);
    assert.equal(EvidenceSchema.safeParse({ status: 'DONE' }).success, false);
    assert.equal(ReviewSchema.safeParse({ recommendation: 'PASS' }).success, false);
  });
});
```

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-contracts.test.js`

Expected: FAIL with `Cannot find module '../lib/dual/contracts'`.

- [ ] **Step 3: Implement strict Zod contracts.**

Use strict `z.object(...).strict()` schemas. Define typed validation commands exactly as:

```js
const ValidationCommandSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).default('.'),
}).strict();
```

Use the existing context/evidence/review field names and enums. `SpecSchema` requires at least one allowed file but does not cap the array; deterministic routing, not schema parsing, keeps specs over three files with Codex. Add transaction correlation fields `schema_version`, `task_id`, and `expected_base_commit` to every semantic artifact. Implement schema export with:

```js
function toDraft7Schema(schema, id) {
  return { $id: id, ...z.toJSONSchema(schema, { target: 'draft-7' }) };
}
```

`parseContract` must join Zod issue paths/messages into one deterministic error without including raw secrets.

- [ ] **Step 4: Run GREEN.**

Run: `node --test test/dual-contracts.test.js`

Expected: all Dual contract tests pass.

- [ ] **Step 5: Commit checkpoint only if separately authorized.**

```powershell
git add lib/dual/contracts.js test/dual-contracts.test.js
git commit -m "feat: define dual transaction contracts"
```

---

### Task 2: Enforce repository identity and file scope

**Files:**
- Create: `lib/dual/workspace.js`
- Create: `lib/dual/scope-guard.js`
- Create: `test/dual-workspace.test.js`

**Interfaces:**
- Produces: `resolveWorkspace(cwd, execGit)` returning `{ repoRoot, head, sourceChanges }`.
- Produces: `normalizeRepoPath(repoRoot, candidate)` returning a normalized `/`-separated relative path or throwing code `DUAL_PATH_ESCAPE`.
- Produces: `assertBaseWorkspace({ repoRoot, expectedBaseCommit, excludedRunDir, execGit })`.
- Produces: `captureDiffFingerprint({ repoRoot, baseCommit, execGit })` returning `{ files, patchSha256 }`.
- Produces: `matchesDenyPattern(repoPath, pattern)`, `assertAllowedDiff({ changedFiles, allowedFiles, denyPatterns })`, and `assertReviewUnchanged(before, after)`.

- [ ] **Step 1: Write RED path and scope tests.**

Use a temporary Git repository and assert:

```js
assert.equal(normalizeRepoPath(repo, 'tests/a.test.js'), 'tests/a.test.js');
assert.throws(() => normalizeRepoPath(repo, '../outside.txt'), { code: 'DUAL_PATH_ESCAPE' });
assert.throws(() => normalizeRepoPath(repo, 'C:\\\\scratch\\\\a.js'), { code: 'DUAL_PATH_ESCAPE' });
assert.throws(() => assertAllowedDiff({
  changedFiles: ['index.html', 'scratch.txt'], allowedFiles: ['index.html'], denyPatterns: [],
}), { code: 'DUAL_SCOPE_VIOLATION' });
assert.throws(() => assertAllowedDiff({
  changedFiles: ['config/.env.local'], allowedFiles: ['config/.env.local'], denyPatterns: ['**/.env*'],
}), { code: 'DUAL_DENY_PATTERN' });
assert.throws(() => assertReviewUnchanged(
  { files: ['index.html'], patchSha256: 'a' },
  { files: ['index.html'], patchSha256: 'b' },
), { code: 'DUAL_REVIEW_MUTATION' });
```

On platforms that allow symlink creation, create a link inside the fixture pointing outside and assert rejection. On Windows without symlink privilege, mark that single case skipped with the OS error while keeping lexical traversal and junction-safe realpath coverage active.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-workspace.test.js`

Expected: FAIL because `lib/dual/workspace.js` and `scope-guard.js` do not exist.

- [ ] **Step 3: Implement workspace and scope guards.**

Execute Git through injected argv calls only:

```js
execGit(['rev-parse', '--show-toplevel'], { cwd });
execGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
execGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot });
execGit(['diff', '--binary', expectedBaseCommit, '--'], { cwd: repoRoot });
```

Canonicalize root and existing candidates with `fs.realpathSync.native`. Reject absolute, drive-qualified, UNC, NUL-containing, or traversal paths before joining. For new files, realpath the nearest existing parent and prove it remains within the canonical root using `path.relative`.

Hash the binary diff with SHA-256. Parse changed file names using NUL-delimited Git output, not localized text. Deny patterns use slash-normalized glob syntax with only `*`, `**`, and `?`; implement and test a local anchored matcher so no new dependency or shell glob expansion is introduced. A deny match wins even when the same path appears in `allowed_files`.

- [ ] **Step 4: Run GREEN.**

Run: `node --test test/dual-workspace.test.js`

Expected: all workspace/scope cases pass or the single privilege-dependent symlink case is explicitly skipped.

- [ ] **Step 5: Commit checkpoint only if authorized.**

```powershell
git add lib/dual/workspace.js lib/dual/scope-guard.js test/dual-workspace.test.js
git commit -m "feat: enforce dual workspace and diff scope"
```

---

### Task 3: Add append-only state and immutable attempts

**Files:**
- Create: `lib/dual/state-store.js`
- Create: `lib/dual/artifacts.js`
- Create: `test/dual-state-store.test.js`

**Interfaces:**
- Produces: `STATES`, `TRANSITIONS`, `deriveState(events)`, `canTransition(from, to)`.
- Produces: `createStateStore(runDir)` with `readEvents()`, `append(event)`, `current()`, `nextAttempt(phase)`, and `hasSuccessfulPhase(phase)`.
- Produces: `createArtifactStore(runDir)` with `writeImmutable(relativePath, content)`, `writeJsonImmutable(relativePath, value)`, `writeJsonAtomic(relativePath, value)`, and `sha256(content)`.
- Consumes: schemas from Task 1.

- [ ] **Step 1: Write RED transition/idempotency tests.**

Cover the exact happy path and illegal shortcuts:

```js
const HAPPY = [
  'NEW', 'PREFLIGHT_SAFE', 'SCOUT_VALID', 'SPEC_VALID', 'ROUTED',
  'IMPLEMENT_VALID', 'SCOPE_VALID', 'REVIEW_VALID', 'CODEX_QC',
];
for (let i = 0; i < HAPPY.length - 1; i++) {
  assert.equal(canTransition(HAPPY[i], HAPPY[i + 1]), true);
}
assert.equal(canTransition('PREFLIGHT_SAFE', 'ROUTED'), false);
assert.equal(canTransition('IMPLEMENT_VALID', 'REVIEW_VALID'), false);
assert.equal(canTransition('ROUTED', 'CODEX_OWNED'), true);
```

Append a truncated NDJSON tail and require `readEvents()` to ignore only the incomplete tail while preserving complete events. Assert a second successful Scout request returns the first attempt instead of incrementing the call count. Assert `writeImmutable` throws `DUAL_ARTIFACT_EXISTS` rather than overwriting.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-state-store.test.js`

Expected: FAIL due to missing state/artifact modules.

- [ ] **Step 3: Implement durable storage.**

Use one JSON object per newline for `events.ndjson`. Validate complete events before append. Write `state.json` through a same-directory temporary file followed by `fs.renameSync`; treat it as a derived cache only. Event replay must verify monotonic attempt numbers, matching task/base identity, allowed transition causation, and referenced artifact hashes.

Write attempt files as `<phase>.<attempt>.<kind>` with exclusive create flag `wx`. Never truncate an existing attempt file.

- [ ] **Step 4: Run GREEN.**

Run: `node --test test/dual-state-store.test.js`

Expected: state replay, immutable artifacts, truncated-tail recovery, and idempotency tests pass.

- [ ] **Step 5: Commit checkpoint only if authorized.**

```powershell
git add lib/dual/state-store.js lib/dual/artifacts.js test/dual-state-store.test.js
git commit -m "feat: persist dual transactions durably"
```

---

### Task 4: Build the cross-platform Agy transport and output adapter

**Files:**
- Create: `lib/dual/agy-runner.js`
- Create: `lib/dual/agy-output.js`
- Create: `test/fixtures/codex-gemini/fake-agy.cjs`
- Create: `test/dual-agy-runner.test.js`

**Interfaces:**
- Produces: `buildAgyInvocation({ agyCommand = 'agy', agyPrefixArgs = [], repoRoot, phase, inputPath, schemaPath, timeoutMs })` returning `{ command, args, cwd, timeoutMs, redactedArgs }`; returned `args` starts with `agyPrefixArgs`.
- Produces: `runProcess(invocation, deps)` returning `{ exitCode, stdout, stderr, timedOut, startedAt, endedAt, durationMs }`.
- Produces: `terminateProcessTree(child, deps)` using `taskkill.exe /PID <pid> /T /F` on Windows and process-group `SIGTERM` followed by bounded `SIGKILL` on POSIX; every helper process also uses `shell: false`.
- Produces: `extractAgyPayload({ exitCode, stdout }, schema)` returning `{ payload, extractionMode, warnings }` or throwing a stable transport/contract error.
- Test seam: `deps.spawn` defaults to Node `spawn`; fake Agy is launched with `command: process.execPath` and `prefixArgs: [fakeAgyPath]`.

- [ ] **Step 1: Write RED argv and output tests.**

Assert `buildAgyInvocation` returns these mandatory arguments as distinct array entries:

```js
[
  '--new-project', '--add-dir', repoRoot,
  '--model', 'gemini-3.7-flash-high',
  '--effort', 'high', '--mode', 'accept-edits',
  '--dangerously-skip-permissions',
  '--output-format', 'json', '--json-schema', schemaPath,
]
```

Assert the last argument starts with `-p=` and contains only a short repo-relative input reference, not serialized spec/evidence content. Assert `shell` passed to spawn is exactly `false`.

Fake-Agy behaviors must include `success`, `outer_error_valid`, `response_json`, `fenced_json`, `malformed`, `empty`, `nonzero`, `permission_denied`, and `timeout`. Verify:

- native and zero-exit compatibility payloads validate;
- compatibility modes add warnings;
- non-zero exit rejects even with valid stdout;
- timeout sets `timedOut: true` and terminates the child;
- timeout termination selects `taskkill.exe` on Windows and negative-PID process-group signals on POSIX through injected test doubles;
- stdout/stderr preserve Unicode.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-agy-runner.test.js`

Expected: FAIL because transport modules and the Node fake worker do not exist.

- [ ] **Step 3: Implement runner and compatibility adapter.**

Spawn using:

```js
const child = spawn(command, [...prefixArgs, ...args], {
  cwd,
  shell: false,
  windowsHide: true,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

On timeout, terminate the full process tree through `terminateProcessTree` and record the timeout result; do not report empty success. Redact only secret-bearing values, not file/scope arguments needed for diagnosis.

Extraction order is `structured_output`, exact JSON `response`, then fenced JSON `response`. Require `exitCode === 0` before extraction and parse the candidate with Task 1's schema. Record `outer_error_valid_payload`, `response_json`, or `legacy_fenced_json` warnings without changing the validated payload.

- [ ] **Step 4: Run GREEN.**

Run: `node --test test/dual-agy-runner.test.js`

Expected: all transport/output scenarios pass without PowerShell.

- [ ] **Step 5: Commit checkpoint only if authorized.**

```powershell
git add lib/dual/agy-runner.js lib/dual/agy-output.js test/fixtures/codex-gemini/fake-agy.cjs test/dual-agy-runner.test.js
git commit -m "feat: run agy through cross-platform argv transport"
```

---

### Task 5: Implement the fail-closed Dual orchestrator

**Files:**
- Create: `lib/dual/orchestrator.js`
- Create: `lib/dual/index.js`
- Create: `test/dual-orchestrator.test.js`
- Use bundled resources: `templates/codex-gemini/prompts/*.md`

**Interfaces:**
- Produces: `createDualOrchestrator({ cwd, agyCommand, agyPrefixArgs, clock, processRunner, gitRunner })`.
- Orchestrator methods: `newTask(taskId)`, `run(taskId)`, `resume(taskId)`, `status(taskId)`, `runPhase(phase, taskId)`.
- Phase methods return `{ taskId, state, owner, nextAction, warnings, reused }` and never print directly.
- Consumes: every module from Tasks 1–4.

- [ ] **Step 1: Write RED phase-order and recovery tests.**

Build a temporary clean Git fixture with one committed `index.html`, configure fake Agy, and cover:

1. `newTask` rejects a non-repository, empty repository, dirty source tree, duplicate task ID, and unsafe task ID.
2. preflight blocks when Agy is missing or `agy models` (parsing plain tab-separated or JSON format for Agy 1.1.19+ resilience) does not contain `gemini-3.7-flash-high`, without invoking print mode.
3. `route` before Scout/spec validation throws `DUAL_TRANSITION_INVALID` and creates no `route.json`.
4. a complete Gemini path reaches `CODEX_QC` with context/evidence/review artifacts.
5. a risky spec and a four-file spec each route to `CODEX_OWNED` without implement/review calls.
6. stale `HEAD` blocks implement.
7. fake worker editing `outside.txt` blocks at scope validation and preserves the diff.
8. fake review mutation blocks and preserves raw review evidence.
9. `resume` after successful Scout does not increment fake-Agy Scout call count.
10. a crash after raw output but before semantic persistence finalizes exactly once when the raw payload and event boundary validate.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-orchestrator.test.js`

Expected: FAIL because the orchestrator is absent.

- [ ] **Step 3: Implement `new`, preflight, Scout, spec validation, and routing.**

`newTask` records canonical repository identity and base commit before writing the transaction. Preflight invokes `agy --version` and `agy models` with `shell: false` (supporting both plain and JSON outputs), then requires an available `gemini-3.7-flash-high` model before `PREFLIGHT_SAFE`; missing CLI/model is `BLOCKED` without a model call. Materialize each worker input from the bundled phase template plus repo-relative references to transaction artifacts; do not embed raw JSON in argv.

For each transition, append `phase.started`, write raw attempt evidence, validate output, write semantic artifact immutably, append `phase.completed`, then update derived state. Route only after context/spec task ID and base commit match.

- [ ] **Step 4: Implement implement, scope validation, review, and QC handoff.**

Use `accept-edits` only for implement and `plan` for Scout/review. Capture a post-implement diff fingerprint, enforce `allowed_files`, then compare the exact fingerprint after review. `REVIEW_VALID` transitions to `CODEX_QC`; Gemini never emits completion authority.

- [ ] **Step 5: Implement run/resume idempotency and bounded retry.**

`run` advances until `CODEX_OWNED`, `CODEX_QC`, or a blocking error. `resume` replays events and reuses successful semantic artifacts. Retry only classified timeout/network transport failures, with at most two attempts; every other failure stops immediately. Return the exact next action in every result.

- [ ] **Step 6: Run GREEN.**

Run: `node --test test/dual-orchestrator.test.js`

Expected: all state, scope, crash-recovery, and idempotency scenarios pass.

- [ ] **Step 7: Commit checkpoint only if authorized.**

```powershell
git add lib/dual/orchestrator.js lib/dual/index.js test/dual-orchestrator.test.js
git commit -m "feat: orchestrate resumable codex-agy transactions"
```

---

### Task 6: Expose `omni dual` commands

**Files:**
- Create: `lib/commands/dual.js`
- Modify: `lib/commands/index.js`
- Modify carefully: `bin/omni.js`
- Create: `test/dual-cli.test.js`

**Interfaces:**
- Produces command handlers: `handleDualNew(taskId)`, `handleDualRun(taskId)`, `handleDualResume(taskId)`, `handleDualStatus(taskId)`, `handleDualPhase(phase, taskId)`.
- Consumes `createDualOrchestrator` from `lib/dual`.
- Process exit code is `0` for a valid `CODEX_OWNED`/`CODEX_QC` stop and non-zero for blocked/invalid operations.

- [ ] **Step 1: Write RED CLI tests.**

Spawn `process.execPath` with `bin/omni.js` and assert:

```text
omni dual --help
omni dual new TASK-1
omni dual status TASK-1
omni dual phase preflight TASK-1
omni dual run TASK-1
omni dual resume TASK-1
```

Help must list all five commands. JSON mode is not added in this change. Status output must include task, state, base commit, attempts, owner, and next action. Errors go to stderr and return non-zero without stack traces for known Dual errors.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-cli.test.js`

Expected: FAIL because `dual` is an unknown command.

- [ ] **Step 3: Implement command registration and handlers.**

Register a top-level Commander group:

```js
const dual = program.command('dual').description('Điều phối Codex + Gemini qua agy');
dual.command('new <task-id>').action(handleDualNew);
dual.command('run <task-id>').action(handleDualRun);
dual.command('resume <task-id>').action(handleDualResume);
dual.command('status <task-id>').action(handleDualStatus);
dual.command('phase <phase> <task-id>').action(handleDualPhase);
```

Render compact Vietnamese summaries. Map known error codes to one actionable message and next command. Do not expose raw stdout in normal success output; raw paths remain available in the transaction.

- [ ] **Step 4: Run GREEN plus syntax check.**

Run:

```powershell
node -c bin/omni.js
node --test test/dual-cli.test.js
```

Expected: syntax check and CLI tests pass on the current host.

- [ ] **Step 5: Commit checkpoint only if authorized.**

Before staging, verify `git diff --ignore-space-at-eol -- bin/omni.js` contains only the intended Dual registration. Then:

```powershell
git add bin/omni.js lib/commands/dual.js lib/commands/index.js test/dual-cli.test.js
git commit -m "feat: expose cross-platform omni dual commands"
```

---

### Task 7: Migrate init output and native skills

**Files:**
- Modify while preserving approved advanced-routing changes: `lib/commands/init.js`
- Modify while preserving approved Dual AGY advanced setup: `lib/commands/init-setup.js`
- Modify: `lib/init/strategies.js`
- Modify: `templates/codex-gemini/SKILL.md`
- Replace with delegation shim: `templates/codex-gemini/ai-flow.ps1`
- Modify: `templates/codex-gemini/prompts/scout.md`
- Modify: `templates/codex-gemini/prompts/implement.md`
- Modify: `templates/codex-gemini/prompts/review.md`
- Modify: `test/init.test.js`
- Modify: `test/codex-gemini-wrapper.test.js`

**Interfaces:**
- `buildInitConfig('dual', { dualPair: 'codex-agy' })` emits native skills and the compatibility shim, but no project-maintained copies of prompt/schema orchestration resources.
- Manifest adds `workerPermissions: 'dangerous-auto'` and `dualOrchestrator: 'omni-dual-v1'`.
- Dual Auto `$om-think` calls `omni dual run <task-id>` after Codex writes the approved bounded spec.
- Legacy `ai-flow.ps1 <phase> <task-id>` delegates to `omni dual phase <phase> <task-id>` and returns the child exit code.

- [ ] **Step 1: Reconcile the existing advanced-setup diff.**

Run focused tests before editing:

```powershell
node --test test/init.test.js test/antigravity-overlay.test.js test/codex-smoke.test.js
```

Expected: the existing Dual advanced target test passes. Keep `getAdvancedSetupTargets('dual', 'codex-agy') === ['codex', 'antigravity']` and `preserveConfigFile` behavior intact.

- [ ] **Step 2: Write RED init/migration assertions.**

Assert generated Dual output:

- contains `.codex/skills/omni-codex-gemini/SKILL.md`;
- contains `.omni/codex-gemini/ai-flow.ps1` only as a compatibility shim;
- does not contain generated `prompts/*.md` or `schemas/*.json`;
- manifest has the two new policy/version fields;
- `$om-think` contains one `omni dual run` instruction and no old `new → preflight → scout → route` relay sequence;
- skill documentation states that Agy uses the approved permission bypass and Codex retains final QC/commit authority.

Update wrapper tests to run only the PowerShell shim on Windows; skip that compatibility-only test on hosts without PowerShell. All orchestration behavior moves to Node tests from Tasks 1–6.

- [ ] **Step 3: Run RED.**

Run: `node --test test/init.test.js test/codex-gemini-wrapper.test.js`

Expected: FAIL because generated resources and native instructions still describe the old PowerShell workflow.

- [ ] **Step 4: Implement init/native-skill migration.**

Change `buildCodexGeminiFiles()` to emit only the native skill and delegation shim. Keep packaged prompts in `templates/codex-gemini/prompts/` for runtime materialization by `lib/dual/artifacts.js`. Generate draft-07 attempt schemas from Task 1 contracts rather than copying schema files into projects.

Make the shim execute:

```powershell
& omni dual phase $Action $TaskId
exit $LASTEXITCODE
```

Print one deprecation line naming `omni dual phase`; do not reimplement validation or Agy invocation in PowerShell.

- [ ] **Step 5: Run GREEN.**

Run:

```powershell
node --test test/init.test.js test/codex-gemini-wrapper.test.js test/antigravity-overlay.test.js test/codex-smoke.test.js
```

Expected: advanced setup, native skills, init generation, and compatibility shim tests all pass.

- [ ] **Step 6: Commit checkpoint only if authorized.**

Inspect the exact combined diff first. If the advanced-setup fix was not separately committed, tell the user that this checkpoint contains both approved changes before staging. Then stage only the listed files and commit with a message that accurately names both scopes, or split the commits if authority permits.

---

### Task 8: Prove cross-platform integration in CI

**Files:**
- Create: `.github/workflows/dual-cross-platform.yml`
- Create: `test/dual-e2e.test.js`
- Modify: `package.json`

**Interfaces:**
- Adds `test:dual`: `node --test test/dual-*.test.js`.
- CI matrix covers `windows-latest`, `ubuntu-latest`, `macos-latest` with Node 20 and current LTS.
- CI has no Agy credentials and cannot call a live model.

- [ ] **Step 1: Write the end-to-end fake-Agy test.**

Create a temporary committed repository, install transaction fixtures, and run the public handlers through:

```text
NEW -> PREFLIGHT_SAFE -> SCOUT_VALID -> SPEC_VALID -> ROUTED
-> IMPLEMENT_VALID -> SCOPE_VALID -> REVIEW_VALID -> CODEX_QC
```

Assert:

- raw metadata contains `shell: false`, package/Agy version, duration, exit code, redacted argv, input/schema hashes;
- Agy receives the canonical repo root and a short input-file reference;
- only allowed files change;
- no commit, push, deploy, stash, reset, or global config write occurs;
- a second `resume` does not increment fake-Agy counters;
- the test executes without invoking `powershell` or `pwsh`.

- [ ] **Step 2: Run RED or expose remaining integration gaps.**

Run: `npm run test:dual`

Expected before completing the task: failing E2E assertions identify any missing metadata/idempotency behavior rather than a live-model error.

- [ ] **Step 3: Add the CI matrix.**

Workflow requirements:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [windows-latest, ubuntu-latest, macos-latest]
    node: [20, 24]
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node }}
      cache: npm
  - run: npm ci
  - run: npm run test:dual
```

Do not add secrets, live smoke, Agy installation, or permission changes to this workflow.

- [ ] **Step 4: Run GREEN locally.**

Run:

```powershell
npm run test:dual
node -e "const p=require('./package.json'); if(!p.scripts['test:dual']) process.exit(1)"
```

Expected: all deterministic Dual tests pass on the current host and the CI workflow statically contains all three operating systems.

- [ ] **Step 5: Commit checkpoint only if authorized.**

```powershell
git add .github/workflows/dual-cross-platform.yml test/dual-e2e.test.js package.json
git commit -m "test: verify dual orchestration across platforms"
```

---

### Task 9: Documentation, full verification, and manual handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/codex-antigravity-orchestration/SKILL.md`
- Modify if implementation differs from approved contract: `plans/codex-gemini/2026-08-24-cross-platform-dual-orchestrator-design.md`
- Create: `plans/codex-gemini/2026-08-24-cross-platform-dual-orchestrator-verification.md`

**Interfaces:**
- Documents `omni dual new|run|resume|status|phase`, transaction files, permission boundary, recovery behavior, and PowerShell shim deprecation.
- Verification report records exact commands, exit codes, test counts, skips, and the absence of live-model execution.

- [ ] **Step 1: Update user-facing documentation.**

README quickstart must show:

```text
omni init
# choose Dual mode -> Codex + Gemini via agy
# in Codex: $om-think

omni dual status <task-id>
omni dual resume <task-id>
```

State clearly that Dual invokes Agy with automatic permission bypass, constrains files through Git scope guards, never changes global Agy settings, and never commits/pushes without separate authority.

- [ ] **Step 2: Run security and static gates.**

```powershell
npm audit --audit-level=high --omit=dev
npm run typecheck:v4
npm run build:v4
node -c bin/omni.js
```

Expected: zero high-severity production dependency vulnerabilities; typecheck, build, and syntax checks exit zero.

- [ ] **Step 3: Run focused and full tests.**

```powershell
npm run test:dual
npm test
git diff --check
```

Expected: all deterministic Dual/core/v4 tests pass; only explicitly documented privilege-dependent symlink cases may skip; diff check is clean.

- [ ] **Step 4: Perform adversarial scope review.**

Verify with fresh commands:

```powershell
git status --short
git diff --stat
git diff --name-only
rg -n "ProcessStartInfo\.Arguments|shell:\s*true|raw.*spec.*args|dangerously-skip-permissions" lib/dual lib/commands templates/codex-gemini test
```

Acceptance:

- no orchestration logic remains in PowerShell;
- no production Dual spawn uses shell mode;
- every Agy worker argv includes the approved bypass;
- no raw contract JSON enters argv;
- the final diff contains no unrelated user files.

- [ ] **Step 5: Verify global-link behavior without reinstalling dependencies.**

If `npm link` is already a junction/symlink to this workspace, run:

```powershell
omni dual --help
```

Expected: new command group appears. If no link exists, report that fact and ask before changing global installation state.

- [ ] **Step 6: Write the verification report.**

Record every command above, observed exit code/test count, host OS/Node version, CI matrix definition, and the live Agy execution record (user-authorized bootstrap delegation for Tasks 5-9 with `gemini-3.7-flash-high`, noting Agy outer envelope ERROR due to the Windows artifact-path bug with independent Codex verification of all accepted edits; all automated tests/CI remain fake-only and credential-free). Distinguish preliminary worker results from final Codex verification with clearly marked placeholders.

- [ ] **Step 7: Final commit only if explicitly authorized.**

Before committing, inspect `git diff --cached`, scan for secrets, and ensure the staged set excludes unrelated files. Suggested final documentation commit:

```powershell
git add README.md docs/codex-antigravity-orchestration/SKILL.md plans/codex-gemini/2026-08-24-cross-platform-dual-orchestrator-verification.md
git commit -m "docs: document resilient dual workflow"
```

Do not push or run a live model unless the user separately authorizes those actions.

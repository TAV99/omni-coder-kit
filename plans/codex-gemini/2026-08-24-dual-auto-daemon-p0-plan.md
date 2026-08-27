# Dual AUTO Authority Daemon P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a workspace-scoped Omni authority daemon that enforces Codex/Agy task ownership, supports Git and greenfield snapshot baselines, and refuses release-qualified completion when Dual delegation or mandatory quality evidence is missing.

**Architecture:** Extend the existing CommonJS `lib/dual/` orchestrator with a local Node.js daemon, append-only authority ledger, pluggable baseline adapters, stable Codex hook bridge, and stdio MCP bridge. The daemon uses authenticated loopback JSON-RPC and remains independent of the experimental Codex app-server daemon; Agy remains a bounded child worker while Codex owns architecture, security contracts, integration, and final QC.

**Tech Stack:** Node.js 20+, CommonJS, native `node:http`, Commander 14, Zod 4, `@modelcontextprotocol/sdk` 1.30.0, Node test runner, Git CLI, Codex hooks/MCP, Antigravity `agy` 1.1.19+.

## Global Constraints

- Supported environments: Windows CMD, Windows PowerShell, Linux, and macOS.
- Do not depend on Bash, WSL, PowerShell on POSIX, or the experimental Codex app-server daemon.
- Codex hooks and MCP contracts must be verified against the installed host; missing trust or blocking capability is `BLOCKED`, not a prompt-only fallback.
- Worker model is exactly `gemini-3.7-flash-high` with effort `high`.
- Every Agy phase includes `--dangerously-skip-permissions`; no global Agy configuration is changed.
- Every child process uses an executable plus argv array. No raw contract JSON, shell operator, redirection, or pipeline may be embedded in a command string.
- Greenfield projects use a snapshot baseline and must not trigger automatic `git init`, commit, push, stash, reset, or deploy.
- Mandatory gate statuses `FAILED`, `BLOCKED`, and `UNAVAILABLE` prevent verified completion. `OPTIONAL_SKIPPED` is legal only when declared optional in the approved spec before execution.
- Codex owns contracts, routing, security boundaries, integration, final QC, and all commit/push decisions.
- Agy receives only bounded implementation slices with at most three production files, explicit tests, and a Codex review gate.
- Existing uncommitted Dual and advanced-init work must be preserved. Never reset, stash, revert, overwrite, or stage unrelated user changes.
- No commit is authorized by this plan. Every commit checkpoint is skipped unless the user separately grants commit authority.

## Authoritative Inputs

- Design: `plans/codex-gemini/2026-08-24-dual-auto-daemon-p0-design.md`
- Runtime incident: `C:\Users\TAV\.codex\attachments\d735ea5c-54f8-4725-ac04-ccf4e6356f50\pasted-text.txt`
- Existing orchestrator design: `plans/codex-gemini/2026-08-24-cross-platform-dual-orchestrator-design.md`
- Current Codex hook behavior: `https://developers.openai.com/codex/hooks`
- Current Codex MCP setup: `https://developers.openai.com/codex/mcp`

## File Map

| Responsibility | File |
|---|---|
| New daemon/session contracts | `lib/dual/contracts.js` |
| Baseline selection and shared helpers | `lib/dual/baseline.js` |
| Existing-Git baseline | `lib/dual/baseline-git.js` |
| Greenfield snapshot baseline | `lib/dual/baseline-snapshot.js` |
| Append-only daemon authority | `lib/dual/authority-store.js` |
| Single-instance and stale-lock logic | `lib/dual/daemon-lock.js` |
| Loopback authenticated daemon | `lib/dual/daemon-server.js` |
| CLI/RPC client | `lib/dual/daemon-client.js` |
| Detached daemon entry point | `bin/omni-daemon.js` |
| Platform-neutral setup | `lib/dual/setup-runner.js` |
| Codex hook adapter | `lib/dual/hook-bridge.js`, `bin/omni-hook.js` |
| Codex MCP adapter | `lib/dual/mcp-server.mjs` |
| Machine quality cycles | `lib/dual/quality-ledger.js` |
| Mandatory browser evidence | `lib/dual/ui-gate.js` |
| Daemon-aware routing/execution | `lib/dual/orchestrator.js` |
| Public commands | `lib/commands/dual.js`, `bin/omni.js` |
| Generated host integration | `lib/init/strategies.js`, `templates/overlays/codex/hooks.template.json`, `templates/codex-gemini/SKILL.md` |

---

## Pre-execution Workspace Gate — Codex

- [ ] **Step 1: Record the exact dirty-tree boundary.**

Run:

```powershell
git branch --show-current
git status --short
git diff --stat
git diff --name-only
```

Expected: branch `v4`; all existing Dual files and the newly approved design/plan remain visible; no cleanup action is taken.

- [ ] **Step 2: Verify the existing implementation before adding P0.**

Run:

```powershell
npm run test:dual
node --test test/init.test.js test/codex-smoke.test.js
```

Expected: current Dual and init suites pass. If they fail, use `systematic-debugging` and repair only the pre-existing regression before P0 work.

- [ ] **Step 3: Record host capability evidence.**

Run:

```powershell
codex --version
codex features list
codex mcp --help
agy --version
agy models
node --version
```

Expected: Node >=20; `hooks` is available; Codex exposes MCP management; Agy exposes `gemini-3.7-flash-high`. Record versions in the later verification report without modifying global configuration.

---

### Task 1: Add daemon, baseline, gate, and setup contracts — Owner: Codex

**Files:**
- Modify: `lib/dual/contracts.js`
- Modify: `lib/dual/index.js`
- Test: `test/dual-daemon-contracts.test.js`

**Interfaces:**
- Produces `BaselineIdentitySchema`, `SessionStateSchema`, `TaskAuthorityStateSchema`, `GateStatusSchema`, `SetupActionSchema`, `SessionEventSchema`.
- Keeps all existing v1 task schemas readable; daemon session events use `schema_version: 2` and `expected_baseline`.
- Produces `normalizeBaselineCorrelation(value)` to map legacy `expected_base_commit` into `{ kind: 'git', id }` without rewriting historical artifacts.

- [ ] **Step 1: Write RED contract tests.**

Create `test/dual-daemon-contracts.test.js` with these core assertions:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BaselineIdentitySchema, GateStatusSchema, SetupActionSchema,
    SessionEventSchema, normalizeBaselineCorrelation,
} = require('../lib/dual/contracts');

test('accepts git and snapshot baseline identities', () => {
    assert.equal(BaselineIdentitySchema.parse({ kind: 'git', id: 'a'.repeat(40) }).kind, 'git');
    assert.equal(BaselineIdentitySchema.parse({ kind: 'snapshot', id: 'b'.repeat(64) }).kind, 'snapshot');
    assert.equal(BaselineIdentitySchema.safeParse({ kind: 'snapshot', id: 'short' }).success, false);
});

test('mandatory gate vocabulary has no ambiguous SKIP', () => {
    for (const status of ['PASSED', 'FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED']) {
        assert.equal(GateStatusSchema.parse(status), status);
    }
    assert.equal(GateStatusSchema.safeParse('SKIP').success, false);
});

test('setup actions are argv-only', () => {
    const action = SetupActionSchema.parse({
        program: 'npm', args: ['install'], cwd: '.', kind: 'package-manager',
    });
    assert.deepEqual(action.args, ['install']);
    assert.equal(SetupActionSchema.safeParse({ command: 'npm install && npm test' }).success, false);
});

test('normalizes legacy git correlation without changing source input', () => {
    const legacy = { schema_version: 1, expected_base_commit: 'c'.repeat(40) };
    assert.deepEqual(normalizeBaselineCorrelation(legacy), {
        kind: 'git', id: 'c'.repeat(40),
    });
    assert.equal(legacy.expected_baseline, undefined);
});
```

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-daemon-contracts.test.js`

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Implement strict v2 contracts without breaking v1.**

Add these exact shapes and extend them with the event-specific payloads required by the design:

```js
const BaselineIdentitySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('git'), id: GitObjectIdSchema }).strict(),
    z.object({ kind: z.literal('snapshot'), id: Sha256Schema }).strict(),
]);
const GateStatusSchema = z.enum([
    'PASSED', 'FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED',
]);
const SessionStateSchema = z.enum([
    'DISCOVERED', 'CAPABILITY_SAFE', 'INTERVIEWING', 'PLANNED',
    'EXECUTING', 'ACCEPTANCE', 'VERIFIED', 'BLOCKED',
]);
const TaskAuthorityStateSchema = z.enum([
    'REGISTERED', 'ROUTED', 'AGY_SCOUT', 'AGY_IMPLEMENT', 'SCOPE_VALID',
    'AGY_REVIEW', 'CODEX_IMPLEMENT', 'CODEX_QC', 'TASK_VERIFIED', 'BLOCKED',
]);
const SetupActionSchema = z.object({
    program: z.string().min(1),
    args: z.array(z.string()),
    cwd: RepoPathSchema.default('.'),
    kind: z.enum(['native', 'node-cli', 'package-manager']),
}).strict();
```

`SessionEventSchema` must be a strict discriminated union for session creation, capability result, plan registration, task routing, lease acquire/renew/release, gate result, task completion, session verification, and blocked state. Every event includes `schema_version: 2`, UUID event/causation IDs, monotonic sequence, workspace ID, session ID, plan revision, baseline identity, and ISO timestamp.

- [ ] **Step 4: Run GREEN and compatibility suites.**

Run:

```powershell
node --test test/dual-daemon-contracts.test.js test/dual-contracts.test.js test/dual-state-store.test.js
```

Expected: new daemon contracts and all existing v1 contract/state tests pass.

- [ ] **Step 5: Codex gate and gated commit checkpoint.**

Inspect `git diff -- lib/dual/contracts.js lib/dual/index.js test/dual-daemon-contracts.test.js`. Do not commit unless separately authorized. Suggested message: `feat: define dual daemon authority contracts`.

---

### Task 2: Introduce the baseline interface and Git adapter — Owner: Codex

**Files:**
- Create: `lib/dual/baseline.js`
- Create: `lib/dual/baseline-git.js`
- Modify: `lib/dual/workspace.js`
- Test: `test/dual-baseline-git.test.js`

**Interfaces:**
- `detectBaselineBackend(root, deps) -> 'git' | 'snapshot'`.
- `createGitBaseline({ root, gitRunner })` with `capture()`, `diff(identity)`, `fingerprint(identity)`, and `assertScope(...)`.
- Existing `resolveWorkspace()` remains backward compatible for v1 callers.

- [ ] **Step 1: Write RED Git adapter tests.**

Use a temporary repository and assert that `capture()` returns `{ kind: 'git', id: HEAD }`, a modified file appears once in `diff()`, NUL-delimited names preserve spaces/Unicode, and stale HEAD throws `DUAL_BASE_COMMIT_STALE`.

```js
const baseline = createGitBaseline({ root: repo, gitRunner });
const identity = baseline.capture();
assert.equal(identity.kind, 'git');
fs.writeFileSync(path.join(repo, 'hello world.txt'), 'changed');
assert.deepEqual(baseline.diff(identity).map(x => x.path), ['hello world.txt']);
```

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-baseline-git.test.js`

Expected: FAIL because baseline modules do not exist.

- [ ] **Step 3: Extract Git behavior behind the adapter.**

Reuse the existing canonical-root, NUL status parsing, path normalization, diff hash, deny-pattern, and junction/symlink protections. Do not duplicate those algorithms. `baseline.js` selects Git when `git rev-parse --show-toplevel` succeeds; otherwise it defers to the snapshot factory injected by Task 3.

- [ ] **Step 4: Run GREEN and existing workspace tests.**

Run:

```powershell
node --test test/dual-baseline-git.test.js test/dual-workspace.test.js test/dual-orchestrator.test.js
```

Expected: Git adapter tests pass and v1 behavior remains unchanged.

- [ ] **Step 5: Codex gate and gated commit checkpoint.**

Review for duplicated Git parsing and any relaxed path check. Do not commit without authority. Suggested message: `refactor: add pluggable dual baseline interface`.

---

### Task 3: Implement the greenfield snapshot baseline — Owner: AGY

**Files:**
- Create: `lib/dual/baseline-snapshot.js`
- Test: `test/dual-baseline-snapshot.test.js`

**Interfaces:**
- `createSnapshotBaseline({ root, fsImpl, cryptoImpl, ignorePolicy })`.
- `capture() -> { identity, manifest }` where identity is `{ kind: 'snapshot', id: sha256 }`.
- `diff(identity, manifest) -> Array<{ path, change: 'created'|'modified'|'deleted' }>`.
- No rollback, deletion, Git command, or daemon lifecycle logic in this task.

- [ ] **Step 1: Codex writes the bounded AGY spec and RED tests.**

The AGY allowed-file list is exactly `lib/dual/baseline-snapshot.js`. Tests must cover empty directory, create/modify/delete, Unicode/spaces, stable ordering, ignored `.omni/runtime`, `.git`, `node_modules`, declared build outputs, and symlink/junction escape.

```js
const first = engine.capture();
fs.writeFileSync(path.join(root, 'src', 'a.js'), 'v2');
const changes = engine.diff(first.identity, first.manifest);
assert.deepEqual(changes, [{ path: 'src/a.js', change: 'modified' }]);
```

- [ ] **Step 2: Run RED before delegation.**

Run: `node --test test/dual-baseline-snapshot.test.js`

Expected: FAIL because the snapshot module does not exist.

- [ ] **Step 3: Delegate bounded implementation to AGY.**

Until the new daemon exists, invoke Agy through the existing direct bounded transport. Require repo-relative paths, `accept-edits`, the approved model/effort/permission policy, and no changes outside the single allowed production file. The implementation must stream file hashes, sort normalized relative paths before root hashing, reject external symlink targets, and avoid reading ignored dependency/build trees.

- [ ] **Step 4: Codex independently reviews and runs GREEN.**

Run:

```powershell
git diff -- lib/dual/baseline-snapshot.js test/dual-baseline-snapshot.test.js
node --test test/dual-baseline-snapshot.test.js test/dual-baseline-git.test.js test/dual-workspace.test.js
```

Expected: snapshot cases pass; no unrelated file changed. Reject AGY prose if source/test evidence disagrees.

- [ ] **Step 5: Gated commit checkpoint.**

Do not commit without authority. Suggested message: `feat: support greenfield snapshot baselines`.

---

### Task 4: Build the append-only authority and lease store — Owner: Codex

**Files:**
- Create: `lib/dual/authority-store.js`
- Modify: `lib/dual/index.js`
- Test: `test/dual-authority-store.test.js`

**Interfaces:**
- `createAuthorityStore(sessionDir, { clock, uuid })`.
- Methods: `append(event)`, `readEvents()`, `derive()`, `acquireLease(taskId, owner)`, `renewLease(leaseId)`, `releaseLease(leaseId)`, `verifyIntegrity()`.
- Lease interval: renewal every 10 seconds, expiry after 30 seconds.

- [ ] **Step 1: Write RED event and lease tests.**

Cover monotonic sequence, wrong workspace/session, bad causation, hash corruption, duplicate active lease, renew-before-expiry, recovery-after-expiry, and refusal to infer success from an expired lease.

```js
const lease = store.acquireLease('TASK-1', 'agy');
clock.advance(10_000);
store.renewLease(lease.lease_id);
clock.advance(31_000);
assert.equal(store.derive().leases[lease.lease_id].status, 'expired');
assert.notEqual(store.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
```

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-authority-store.test.js`

Expected: missing-module failure.

- [ ] **Step 3: Implement durable authority.**

Write one strict v2 event per line with `fs.openSync(..., 'a')`, append, `fs.fsyncSync`, and close. Hash-chain each event over the previous hash plus canonical JSON payload. Derived state is reconstructed only by replaying validated events. A trailing incomplete line may be ignored only when no newline committed it; malformed complete lines block replay.

- [ ] **Step 4: Run GREEN and corruption tests.**

Run:

```powershell
node --test test/dual-authority-store.test.js test/dual-state-store.test.js
```

Expected: all v2 authority and existing v1 state tests pass.

- [ ] **Step 5: Codex gate and gated commit checkpoint.**

Review fsync behavior, replay determinism, and absence of source deletion/revert logic. Suggested gated message: `feat: persist dual daemon authority and leases`.

---

### Task 5: Implement daemon lock and authenticated loopback server — Owner: AGY

**Files:**
- Create: `lib/dual/daemon-lock.js`
- Create: `lib/dual/daemon-server.js`
- Test: `test/dual-daemon-lifecycle.test.js`

**Interfaces:**
- `acquireDaemonLock({ runtimeDir, workspaceId, pid, startedAt, healthProbe })`.
- `startDaemonServer({ workspaceRoot, authorityStore, clock, idleTimeoutMs })`.
- RPC methods initially: `health`, `session.begin`, `session.status`, `hook.evaluate`, `completion.evaluate`, `daemon.stop`.

- [ ] **Step 1: Codex writes RED lifecycle tests.**

Tests must prove dynamic loopback binding, token rejection, workspace mismatch rejection, single instance, live lock refusal, stale PID reclaim only after failed authenticated health, request size limit, malformed JSON rejection, and idle shutdown with no active lease.

```js
const daemon = await startDaemonServer({ workspaceRoot, authorityStore, idleTimeoutMs: 50 });
const denied = await request(daemon, { token: 'wrong', method: 'health' });
assert.equal(denied.statusCode, 401);
assert.equal(daemon.address.host, '127.0.0.1');
```

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-daemon-lifecycle.test.js`

Expected: missing-module failure.

- [ ] **Step 3: Delegate bounded implementation to AGY.**

AGY may edit only the two production files. Use native `node:http`, `crypto.randomBytes(32)`, exclusive lock creation, and constant-time token comparison. Bind only `127.0.0.1`. Do not add WebSocket, OS service installation, app-server dependency, shell command, Git mutation, or source rollback.

- [ ] **Step 4: Codex reviews and runs GREEN.**

Run:

```powershell
git diff -- lib/dual/daemon-lock.js lib/dual/daemon-server.js test/dual-daemon-lifecycle.test.js
node --test test/dual-daemon-lifecycle.test.js test/dual-authority-store.test.js
```

Expected: lifecycle tests pass; server rejects unauthenticated/cross-workspace calls; no listener binds non-loopback interfaces.

- [ ] **Step 5: Gated commit checkpoint.**

No commit without authority. Suggested message: `feat: add workspace-scoped dual daemon`.

---

### Task 6: Add daemon client and lifecycle CLI — Owner: Codex

**Files:**
- Create: `lib/dual/daemon-client.js`
- Create: `bin/omni-daemon.js`
- Modify: `lib/commands/dual.js`
- Modify: `bin/omni.js`
- Test: `test/dual-daemon-cli.test.js`

**Interfaces:**
- `createDaemonClient({ workspaceRoot, timeoutMs = 500 })`.
- Commands: `omni dual daemon start|status|stop`.
- Command: `omni dual baseline promote`, which verifies an existing user-created Git `HEAD` matches the accepted snapshot workspace before future transactions switch backend.
- Internal detached start uses the current Node executable and `shell: false`; Windows child window is hidden.

- [ ] **Step 1: Write RED CLI tests.**

Spawn `process.execPath bin/omni.js dual daemon ...` inside a temporary workspace. Assert start is idempotent, status prints PID/protocol/workspace without token, stop is authenticated, and absent/stale runtime data produces actionable non-zero errors. Add baseline-promotion cases for no Git repository, missing HEAD, tree mismatch, and exact snapshot/tree match; only the final case may append a `baseline.promoted` event.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-daemon-cli.test.js`

Expected: unknown daemon subcommand.

- [ ] **Step 3: Implement client and lifecycle handlers.**

Use `http.request` with a 500 ms default timeout. Read runtime discovery data only from the canonical workspace. Start the daemon using:

```js
const daemonEntrypoint = path.join(__dirname, '..', '..', 'bin', 'omni-daemon.js');
spawn(process.execPath, [daemonEntrypoint, '--workspace', workspaceRoot], {
    cwd: workspaceRoot,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
}).unref();
```

Poll authenticated `health` with condition-based waiting; do not use a fixed sleep. Never print bearer tokens.

- [ ] **Step 4: Run GREEN.**

Run:

```powershell
node -c bin/omni.js
node --test test/dual-daemon-cli.test.js test/dual-cli.test.js
```

Expected: lifecycle and existing Dual commands pass.

- [ ] **Step 5: Codex gate and gated commit checkpoint.**

Review only intended Commander registration in `bin/omni.js`. Suggested gated message: `feat: expose dual daemon lifecycle commands`.

---

### Task 7: Replace Bash-only setup with typed actions — Owner: AGY

**Files:**
- Create: `lib/dual/setup-runner.js`
- Modify: `templates/workflows/task-planning.md`
- Modify: `templates/workflows/coder-execution.md`
- Test: `test/dual-setup-runner.test.js`
- Test: `test/workflow-command-contracts.test.js`

**Interfaces:**
- `resolveSetupInvocation(action, { platform, env, resolveExecutable }) -> { command, args, cwd, shell: false }`.
- `runSetupActions(actions, deps) -> typed results`.
- Workflows generate `.omni/sdlc/setup.json`, then call `omni dual setup run`; they never create or require `setup.sh`.

- [ ] **Step 1: Codex writes RED resolver and template tests.**

Cover native executables, Node CLI entry points, lockfile mapping, conflicting lockfiles, spaces/Unicode, forbidden shell operators, Windows `.cmd` rejection unless resolved to a trusted Node entrypoint, and stale text scans.

```js
assert.throws(() => resolveSetupInvocation({
    kind: 'native', program: 'npm install && npm test', args: [], cwd: '.',
}, deps), { code: 'DUAL_SETUP_PROGRAM_INVALID' });
assert.equal(result.shell, false);
```

`test/workflow-command-contracts.test.js` must fail when templates contain `omni auto-equip`, bare `omni equip`, `bash setup.sh`, or an instruction to stop AUTO for ordinary dependency setup.

- [ ] **Step 2: Run RED.**

Run:

```powershell
node --test test/dual-setup-runner.test.js test/workflow-command-contracts.test.js
```

Expected: setup module missing and stale workflow strings detected.

- [ ] **Step 3: Delegate bounded implementation to AGY.**

AGY edits only the three production files. The resolver must prefer the approved spec, then deterministic lockfile detection. On Windows, resolve supported JavaScript package managers to verified Node CLI entrypoints or a native executable; do not invoke `cmd.exe /c` or assume `.cmd` is directly executable with `shell:false`. Unknown wrappers and conflicting lockfiles are blocking errors.

- [ ] **Step 4: Codex reviews and runs GREEN.**

Run:

```powershell
git diff -- lib/dual/setup-runner.js templates/workflows/task-planning.md templates/workflows/coder-execution.md
node --test test/dual-setup-runner.test.js test/workflow-command-contracts.test.js
```

Expected: no Bash-only or removed CLI command remains; all execution records use argv arrays.

- [ ] **Step 5: Gated commit checkpoint.**

No commit without authority. Suggested message: `fix: make auto setup platform neutral`.

---

### Task 8: Build the verified Codex hook bridge — Owner: AGY

**Files:**
- Create: `lib/dual/hook-bridge.js`
- Create: `bin/omni-hook.js`
- Modify: `templates/overlays/codex/hooks.template.json`
- Test: `test/dual-hook-bridge.test.js`

**Interfaces:**
- `evaluateHook(input, daemonClient) -> Codex hook response`.
- Supports `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
- PreToolUse denial uses the current official shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "[omni-blocked] task is AGY_OWNED"
  }
}
```

- Stop continuation uses `{ "decision": "block", "reason": "..." }`; it tells Codex to continue rather than pretending to reject an already-finished turn.

- [ ] **Step 1: Codex writes RED hook contract tests.**

Feed newline JSON on stdin and assert stdout is exactly one valid JSON object. Cover allowed Codex-owned edit, denied AGY-owned apply_patch, mutating Bash outside scope, post-tool observation, daemon timeout, untrusted/missing runtime, verified completion, incomplete completion, and terminal `BLOCKED` requiring user input.

For daemon loss during `PreToolUse`, expect denial. For a terminal blocked session at `Stop`, allow the turn to end but inject a clear blocked status; do not create an infinite continuation loop.

- [ ] **Step 2: Run RED.**

Run: `node --test test/dual-hook-bridge.test.js`

Expected: missing hook bridge.

- [ ] **Step 3: Delegate bounded implementation to AGY.**

AGY edits only the three production/template files. The hook bridge has a 500 ms RPC timeout, never prints debug text to stdout, sends diagnostics to stderr, and returns fail-closed output for source mutations when daemon authority is unavailable. Match canonical `Bash`, `apply_patch`, and MCP tool names; `apply_patch` also covers Edit/Write aliases.

- [ ] **Step 4: Codex verifies source behavior and live capability separately.**

Run deterministic tests:

```powershell
node --test test/dual-hook-bridge.test.js test/codex-smoke.test.js
```

Then, in an isolated temporary workspace and only with live-smoke authority, run a controlled Codex hook probe proving a denied write does not occur. Generated JSON alone is not acceptance evidence.

- [ ] **Step 5: Gated commit checkpoint.**

No commit without authority. Suggested message: `feat: enforce dual ownership through Codex hooks`.

---

### Task 9: Expose daemon tools through stdio MCP — Owner: AGY

**Files:**
- Create: `lib/dual/mcp-server.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `test/dual-mcp-server.test.js`

**Interfaces:**
- Adds dependency `@modelcontextprotocol/sdk` at `^1.30.0`.
- MCP tools: `omni_dual_begin`, `omni_dual_register_plan`, `omni_dual_status`, `omni_dual_completion`, `omni_dual_resume`.
- All tool input uses strict Zod schemas and delegates authority to the daemon; the MCP process stores no independent session state.

- [x] **Step 1: Codex writes RED MCP tests.**

Start the server as a child process, complete MCP initialize, list tools, call status against a fake daemon, reject wrong workspace/session, and assert stderr logging never corrupts stdout protocol frames.

- [x] **Step 2: Add the SDK dependency and confirm the lockfile diff.**

Run:

```powershell
npm install @modelcontextprotocol/sdk@^1.30.0
npm ls @modelcontextprotocol/sdk
```

Expected: one direct dependency compatible with Node >=20; inspect `package.json` and `package-lock.json` for unrelated upgrades before continuing.

- [x] **Step 3: Run RED.**

Run: `node --test test/dual-mcp-server.test.js`

Expected: MCP server module missing.

- [x] **Step 4: Delegate bounded implementation to AGY, then run GREEN.**

AGY may create only `lib/dual/mcp-server.mjs`; dependency files remain Codex-owned. Use `McpServer` and `StdioServerTransport` from the official SDK. Each tool calls `daemon-client` and returns compact structured content; it cannot write session events directly.

Run:

```powershell
node --test test/dual-mcp-server.test.js
npm audit --audit-level=high --omit=dev
```

Expected: protocol tests pass and no high-severity production vulnerability is introduced.

- [ ] **Step 5: Gated commit checkpoint.**

No commit without authority. Suggested message: `feat: expose dual daemon through MCP`.

---

### Task 10: Implement machine quality cycles and UI gate — Owner: AGY

**Files:**
- Create: `lib/dual/quality-ledger.js`
- Create: `lib/dual/ui-gate.js`
- Test: `test/dual-quality-ledger.test.js`
- Test: `test/dual-ui-gate.test.js`

**Interfaces:**
- `cycleThresholds(total) -> [ceil(N/3), ceil(2N/3), N]`; duplicate thresholds remain for small `N`, and each index still requires its own cycle record.
- `evaluateMandatoryGates(gates) -> { verdict, blockers }`.
- `evaluateUiEvidence(requirement, evidence) -> GateResult`.

- [x] **Step 1: AGY writes RED cycle and gate tests under Codex review.**

Cover task totals 1, 2, 3, 7, and 10; maximum three fix attempts; plan revision mismatch; diff fingerprint mismatch; `SKIP` rejection; mandatory unavailable browser; optional predeclared browser gate; viewport set 390/768/1024/1440; horizontal overflow at 390; reduced-motion evidence.

```js
assert.deepEqual(cycleThresholds(7), [3, 5, 7]);
assert.equal(evaluateMandatoryGates([
    { id: 'browser', required: true, status: 'UNAVAILABLE' },
]).verdict, 'BLOCKED');
```

- [x] **Step 2: Run RED.**

Run:

```powershell
node --test test/dual-quality-ledger.test.js test/dual-ui-gate.test.js
```

Expected: missing modules.

- [x] **Step 3: Delegate bounded implementation to AGY.**

AGY edits only the two production files. These modules evaluate typed evidence and append results through the authority-store interface; they do not launch a browser themselves, mutate todo files, or mark a session verified.

- [x] **Step 4: Codex reviews and runs GREEN.**

Run:

```powershell
git diff -- lib/dual/quality-ledger.js lib/dual/ui-gate.js
node --test test/dual-quality-ledger.test.js test/dual-ui-gate.test.js test/dual-authority-store.test.js
```

Expected: exact thresholds and fail-closed semantics pass; no generic `SKIP` status exists.

- [ ] **Step 5: Gated commit checkpoint.**

No commit without authority. Suggested message: `feat: enforce machine quality and UI gates`.

---

### Task 11: Integrate daemon ownership into Dual AUTO and init — Owner: AGY (Codex review)

**Files:**
- Modify: `lib/dual/orchestrator.js`
- Modify: `lib/dual/index.js`
- Modify: `lib/dual/daemon-server.js`
- Modify: `lib/dual/daemon-client.js`
- Modify: `lib/dual/hook-bridge.js`
- Modify: `bin/omni-hook.js`
- Modify: `lib/commands/dual.js`
- Modify: `lib/commands/init-setup.js`
- Modify: `lib/commands/init.js`
- Modify: `lib/init/strategies.js`
- Modify: `templates/codex-gemini/SKILL.md`
- Modify: `templates/overlays/codex/config.template.toml`
- Modify: `templates/overlays/codex/hooks.template.json`
- Modify: `templates/workflows/skill-manager.md`
- Modify: `test/init.test.js`
- Modify: `test/codex-smoke.test.js`
- Modify: `test/dual-daemon-client.test.js`
- Modify: `test/dual-daemon-lifecycle.test.js`
- Modify: `test/dual-hook-bridge.test.js`
- Create: `test/dual-daemon-orchestrator.test.js`

**Interfaces:**
- `$om-think` calls `omni_dual_begin`, then registers the approved plan through MCP.
- New daemon sessions choose `git` or `snapshot` baseline.
- The generated `SessionStart` hook bootstraps or attaches to the workspace daemon through Node APIs; it does not rely on PowerShell, Bash, or a globally resolved `omni` executable.
- The daemon implements the already-published `plan.register` and `session.resume` RPCs and derives first-time verification from acceptance evidence instead of requiring a pre-existing receipt.
- The router writes durable `AGY_OWNED`, `CODEX_OWNED`, and `CODEX_QC` transitions.
- Init emits the MCP server configuration and hook commands for `dual + auto + codex-agy` only.

- [x] **Step 1: AGY writes RED integration tests under Codex review.**

Cover:

1. Dual AUTO init emits daemon-aware hooks and an `omni_dual` MCP entry.
2. Manual/single-agent init does not force the authority daemon.
3. Generated workflows use only canonical `omni skills` and `omni skills add` commands.
4. Greenfield begin selects snapshot without running any Git mutation.
5. Existing Git begin selects Git HEAD.
6. An eligible task launches Agy and records delegation evidence.
7. Codex architecture/risky tasks remain Codex-owned.
8. Missing delegation evidence prevents completion.
9. Stop evaluation continues an incomplete active session but terminates cleanly in a user-blocked state.
10. Resume reuses successful Agy phases.

- [x] **Step 2: Run RED.**

Run:

```powershell
node --test test/dual-daemon-orchestrator.test.js test/init.test.js
```

Expected: daemon session integration absent.

- [x] **Step 3: Integrate without duplicating the current orchestrator.**

Make the daemon call existing Agy runner, output adapter, artifacts, scope guard, and phase logic through injected interfaces. Do not maintain a second Agy state machine. Session authority wraps task transactions and records owner/quality/completion events; v1 `omni dual new|run|resume|status|phase` remains compatible.

Capability evidence must be produced by an injected/real preflight and appended before plan registration. `plan.register` must never fabricate a passing `capability.result`. The production preflight verifies the materialized Codex hooks/MCP setup, baseline backend, Agy CLI, approved model, and authority-store integrity; tests inject deterministic results.

`completion.evaluate` remains fail-closed. When and only when the session is in `ACCEPTANCE`, every registered task is `TASK_VERIFIED`, required quality/delegation/review/UI gates pass, no lease is active or expired, and the current baseline fingerprint matches the accepted evidence, it appends the single `session.verified` event and returns its receipt. Repeated evaluation is idempotent. Snapshot acceptance writes `accepted-snapshot.json` only as a consequence of this verified transition.

Update generated Codex config to enable the current `hooks` feature name. Build the project MCP entry from resolved package paths rather than a template placeholder:

```js
const packageRoot = path.resolve(__dirname, '..', '..');
const omniDualMcp = {
    command: process.execPath,
    args: [path.join(packageRoot, 'lib', 'dual', 'mcp-server.mjs')],
};
```

Path materialization must be performed by init with platform-correct absolute paths; do not embed a developer-machine path in templates.

Replace every removed skill command in `templates/workflows/skill-manager.md`: `omni auto-equip -y` becomes `omni skills -y`, and `omni equip <source> --name <name>` becomes `omni skills add <source> --name <name>`. Do not add aliases that preserve obsolete user-facing documentation unless a separate compatibility requirement is approved.

- [x] **Step 4: Run GREEN and regression suites.**

Run:

```powershell
node --test test/dual-daemon-orchestrator.test.js test/init.test.js test/codex-smoke.test.js
npm run test:dual
```

Expected: daemon routing and all existing Dual/init tests pass.

- [x] **Step 5: Codex adversarial gate.**

Inspect the diff for prompt-only completion paths, duplicate state machines, accidental global config writes, automatic Git operations, app-server dependency, and any route allowing Gemini final approval.

- [ ] **Step 6: Gated commit checkpoint.**

No commit without authority. Suggested message: `feat: enforce dual auto through authority daemon`.

---

### Task 12: Cross-platform E2E, AI4Teacher live smoke, and documentation — Owner: Codex

**Files:**
- Create: `test/dual-daemon-e2e.test.js`
- Modify: `.github/workflows/dual-cross-platform.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/codex-antigravity-orchestration/SKILL.md`
- Create: `plans/codex-gemini/2026-08-24-dual-auto-daemon-p0-verification.md`

**Interfaces:**
- `test:dual` includes all daemon tests.
- Fake-only CI runs Windows, Ubuntu, and macOS on Node 20 and current LTS.
- Verification report separates deterministic CI, current-host hook/MCP capability smoke, Agy live smoke, browser smoke, committed state, and release qualification.

- [x] **Step 1: Write the fake end-to-end test.**

Exercise:

```text
greenfield snapshot -> daemon begin -> plan register -> AGY-owned fake task
-> scoped edit -> review -> Codex QC -> three quality records
-> mandatory gates passed -> completion receipt -> VERIFIED
```

Add adversarial cases for Codex write during AGY ownership, daemon loss, wrong token, source bypass mutation, unavailable browser, corrupt ledger, stale lease, and resume without repeated model calls.

Implemented in the consolidated `test/dual-daemon-orchestrator.test.js`, `test/dual-adversarial-review-2.test.js`, `test/dual-daemon-lifecycle.test.js`, `test/dual-hook-bridge.test.js`, and `test/dual-ui-gate.test.js` suites rather than duplicating the daemon lifecycle in a separate test file.

- [x] **Step 2: Run focused security/static gates.**

Run:

```powershell
node -c bin/omni.js
npm audit --audit-level=high --omit=dev
rg -n "shell:\s*true|cmd\.exe\s*/c|bash setup\.sh|omni auto-equip|omni equip\s" lib/dual lib/commands/dual.js bin/omni-daemon.js bin/omni-hook.js templates/workflows templates/codex-gemini templates/overlays/codex test
```

Expected: syntax passes; zero high production vulnerabilities; no prohibited execution or stale workflow command remains on the Dual P0 runtime/template path. Test fixtures may contain prohibited strings only when explicitly asserting rejection. Legacy non-Dual harness/agent-pair findings are recorded separately rather than silently included in the Dual gate.

- [x] **Step 3: Run deterministic verification.**

Run:

```powershell
npm run test:dual
npm run typecheck:v4
npm run build:v4
npm test
git diff --check
```

Expected: all deterministic Dual/core/v4 checks pass. Record exact counts and conditional skips.

- [x] **Step 4: Verify the CI matrix definition.**

Ensure `.github/workflows/dual-cross-platform.yml` runs fake-only tests on `windows-latest`, `ubuntu-latest`, and `macos-latest`, Node 20 and the current LTS, without Agy/Codex credentials.

- [x] **Step 5: Run current-host Codex hook and MCP smoke.**

In a temporary initialized Dual project:

1. trust the generated project hooks through the normal Codex trust flow;
2. prove `SessionStart` reaches the daemon;
3. prove a controlled `PreToolUse` source write is denied during AGY ownership;
4. prove MCP tools list and call the same daemon session;
5. stop the daemon and prove a source mutation is denied fail-closed;
6. prove terminal user-blocked state does not create an infinite Stop continuation.

Expected: fresh runtime evidence, not generated-config inspection.

- [ ] **Step 6: Rerun the AI4Teacher greenfield acceptance scenario.**

Acceptance requires:

- at least one actual Agy scout/implement/review transaction;
- Codex-owned design/routing evidence;
- snapshot baseline with no Git initialization or commit;
- three durable quality-cycle records;
- browser QA at 390, 768, 1024, and 1440 pixels;
- no horizontal overflow at 390;
- real reduced-motion evidence;
- Codex independent final QC;
- no automatic commit, push, deploy, stash, reset, or external-system mutation.

If browser runtime is absent, record `UNAVAILABLE -> BLOCKED`; do not call the scenario complete.

- [x] **Step 7: Write documentation and verification report.**

Document daemon lifecycle, runtime paths, hook trust, MCP setup, snapshot/Git baselines, setup manifest, recovery, gate statuses, manual repair commands, and rollback boundaries. Record AGY outer-envelope warnings separately from locally validated structured payloads.

- [x] **Step 8: Final completion review.**

Run:

```powershell
git status --short
git diff --stat
git diff --name-only
git diff --check
```

Confirm the diff contains only approved P0 work plus the preserved pre-existing Dual changes. Do not stage or commit until the user explicitly authorizes it.

---

## Execution Order and AGY Handoff Rules

Execute tasks strictly in order because later AGY slices consume Codex-owned contracts from earlier tasks.

| Task | Owner | Fresh AGY call? | Codex acceptance gate |
|---|---|---:|---|
| 1 Contracts | Codex | No | v1 compatibility and strict v2 schemas |
| 2 Git baseline | Codex | No | Existing workspace/orchestrator tests |
| 3 Snapshot baseline | AGY | Yes | Diff/symlink/ignore tests and scope review |
| 4 Authority store | Codex | No | Replay, corruption, lease tests |
| 5 Daemon lifecycle | AGY | Yes | Auth, single-instance, loopback tests |
| 6 Daemon CLI | Codex | No | Public CLI and no-token output |
| 7 Setup runner | AGY | Yes | Windows/POSIX resolver and stale-text scan |
| 8 Hook bridge | AGY | Yes | Official shape tests plus live deny smoke |
| 9 MCP bridge | AGY | Yes | Protocol test and dependency audit |
| 10 Quality/UI gates | AGY | Yes | Exact thresholds and fail-closed statuses |
| 11 Integration | Codex | No | Routing, init, completion and regression tests |
| 12 E2E/release evidence | Codex | No | Full suites plus fresh AI4Teacher smoke |

For every AGY task:

1. Codex creates the RED test and bounded spec first.
2. AGY receives only the task-specific files and exact expected commands.
3. AGY runs with the approved model, effort, and permission bypass but has no commit/push/deploy authority.
4. Codex reads the actual diff, checks allowed files, reruns tests independently, and rejects unsupported prose claims.
5. The next task does not begin until the Codex gate passes.

## Completion Definition

P0 is complete only when all twelve tasks pass, deterministic CI is green on all three operating systems, current-host Codex hook/MCP capability smoke passes, and the fresh AI4Teacher scenario produces real Agy delegation plus complete browser evidence. Passing source/fake tests without those live-host gates is implemented and automated-tested, not release-qualified.

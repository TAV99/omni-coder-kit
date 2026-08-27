# Dual Self-Healing Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Dual recover automatically from a failed `SessionStart` bootstrap while allowing `$om-think` to operate before authority initialization.

**Architecture:** Extend the existing idempotent daemon bootstrap path to `UserPromptSubmit`, distinguish pre-authority from initialized authority using the durable ledger, and keep strict enforcement unchanged after initialization. Increase only the two bootstrap-capable hook timeouts.

**Tech Stack:** Node.js CommonJS, Node test runner, Codex `hooks.json`, PowerShell and POSIX command launchers.

## Global Constraints

- Preserve the current daemon protocol and ledger schemas.
- Preserve strict fail-closed behavior after a durable authority session exists.
- Preserve absolute command paths and platform-specific quoting.
- Do not commit, push, deploy, or recover deleted project files.

---

### Task 1: Lock the self-healing behavior with regression tests

**Files:**
- Modify: `test/dual-hook-bridge.test.js`
- Modify: `test/init.test.js`

**Interfaces:**
- Consumes: `evaluateHook(rawInput, deps): Promise<object>` and `buildCodexHooks(ide, advanced, opts): string | null`.
- Produces: regression coverage for bootstrap retry, pre-authority access, initialized fail-closed behavior, and timeout materialization.

- [x] **Step 1: Add a failing UserPromptSubmit recovery test**

Use an injected client whose first `health()` result is unavailable and whose `waitForHealthy()` result is healthy. Assert that `UserPromptSubmit` invokes the spawn seam and returns daemon-running context.

- [x] **Step 2: Add failing pre-authority tests**

Assert that, with no authority ledger, unavailable or healthy-without-session states return `{}` for a compound Bash inspection, an SDLC `apply_patch`, and `Stop`.

- [x] **Step 3: Preserve initialized fail-closed coverage**

Create a non-empty `.omni/runs/dual-authority/events.ndjson`, make daemon health unavailable, and assert that a mutating `PreToolUse` remains denied.

- [x] **Step 4: Add generated-timeout assertions**

Assert `SessionStart` and `UserPromptSubmit` use 15 seconds while enforcement hooks retain 5 seconds.

- [x] **Step 5: Run RED**

Run:

```text
node --test --test-name-pattern="UserPromptSubmit self-heals|pre-authority|bootstrap hook timeouts" test/dual-hook-bridge.test.js test/init.test.js
```

Expected: the new recovery and pre-authority assertions fail against current behavior.

---

### Task 2: Implement the minimal bridge state distinction

**Files:**
- Modify: `lib/dual/hook-bridge.js:847-1015`

**Interfaces:**
- Consumes: workspace root, `.omni/runs/dual-authority/events.ndjson`, daemon client health, and hook event name.
- Produces: `hasDurableAuthority(workspaceRoot, fsImpl): boolean` and self-healing hook outcomes.

- [x] **Step 1: Add durable-authority detection**

Return true only when `events.ndjson` exists as a regular, non-empty file. Any filesystem inspection error returns true so enforcement fails closed.

- [x] **Step 2: Extend bounded bootstrap to UserPromptSubmit**

Use the existing spawn and `waitForHealthy` path when the event is either `SessionStart` or `UserPromptSubmit`.

- [x] **Step 3: Make unavailable pre-authority advisory**

When daemon health is unavailable and no durable authority exists, return `{}` for `PreToolUse` and `Stop`. Preserve the existing unavailable-daemon denial when durable authority exists.

- [x] **Step 4: Make healthy no-session pre-authority advisory**

Before classifying a `PreToolUse` or processing `Stop`, return `{}` when health is healthy but `session_id` is absent.

- [x] **Step 5: Run GREEN**

Run the focused command from Task 1 and require zero failures.

---

### Task 3: Materialize resilient bootstrap timeouts

**Files:**
- Modify: `templates/overlays/codex/hooks.template.json`
- Update: `E:\demoSite\.codex\hooks.json`

**Interfaces:**
- Consumes: Codex hook timeout contract in seconds.
- Produces: 15-second timeout for `SessionStart` and `UserPromptSubmit`; unchanged 5-second enforcement hooks.

- [x] **Step 1: Change only bootstrap-capable timeout values**

Set the two values to `15`; leave `PreToolUse`, `PostToolUse`, and `Stop` at `5`.

- [x] **Step 2: Update the existing DemoSite hook file**

Apply the same two timeout changes without regenerating or overwriting unrelated project files.

- [x] **Step 3: Verify generated configuration**

Run the focused init and hook tests and require zero failures.

---

### Task 3B: Detach the daemon from the Windows hook host

**Files:**
- Modify: `lib/dual/hook-bridge.js`
- Modify: `test/codex-smoke.test.js`
- Modify: `test/dual-daemon-orchestrator.test.js`

**Interfaces:**
- Consumes: absolute Node path, daemon entrypoint, workspace root, and current platform.
- Produces: a daemon process independent of the Codex hook's outer shell.

- [x] **Step 1: Reproduce the real PowerShell timeout with a bounded smoke test**

- [x] **Step 2: Launch Windows daemon through hidden PowerShell `Start-Process`**

- [x] **Step 3: Preserve the direct POSIX spawn contract for Linux and macOS**

- [x] **Step 4: Verify a real Windows cold bootstrap exits within the 15-second hook contract**

---

### Task 4: Verify the incident sequence and regressions

**Files:**
- Update checkboxes in this plan only.

**Interfaces:**
- Consumes: completed bridge and hook configuration.
- Produces: fresh evidence that the reported failure sequence is resolved.

- [x] **Step 1: Run focused suites**

```text
node --test --test-concurrency=1 test/dual-hook-bridge.test.js test/dual-daemon-orchestrator.test.js test/codex-smoke.test.js test/init.test.js
```

- [x] **Step 2: Run Dual regression suite**

```text
npm run test:dual
```

- [x] **Step 3: Run full repository suite**

```text
npm test
```

- [x] **Step 4: Run real DemoSite checks**

Stop the current diagnostic daemon, invoke `SessionStart`, verify exit 0, then invoke `UserPromptSubmit` and a pre-authority tool payload. Require no timeout and no blocking output.

- [x] **Step 5: Inspect final diff**

Run `node -c`, `git diff --check`, and a scoped diff review. Do not commit.

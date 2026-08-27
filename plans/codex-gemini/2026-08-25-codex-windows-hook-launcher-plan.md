# Codex Windows Hook Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated Codex Dual hooks start reliably under Windows PowerShell without weakening absolute-path execution.

**Architecture:** Change only the Windows command materialization in `buildCodexHooks`. Verify the actual generated command through PowerShell and retain the existing POSIX command contract.

**Tech Stack:** Node.js CommonJS, Node test runner, PowerShell on Windows.

## Global Constraints

- Linux and macOS `command` output remains unchanged.
- Windows uses absolute Node and hook paths.
- No shell-success suppression.
- No commit, push, or deploy without separate authorization.

---

### Task 1: PowerShell-safe Windows hook command

**Files:**
- Modify: `test/codex-smoke.test.js`
- Modify: `lib/init/strategies.js:96-104`
- Verify: `test/init.test.js`, `test/dual-hook-bridge.test.js`

**Interfaces:**
- Consumes: `buildCodexHooks(ide, advanced, opts): string | null`
- Produces: `commandWindows = & "<absolute-node>" "<absolute-hook>"`

- [x] **Step 1: Write the failing test**

Assert that the generated Windows command begins with `& `, preserves both absolute paths, and, on Windows, returns exit 0 plus `{}` when invoked by `powershell.exe` with a valid `UserPromptSubmit` payload.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="PowerShell-safe" test/codex-smoke.test.js`

Expected: FAIL because the generated command currently starts with a quoted executable path rather than `& `.

- [x] **Step 3: Implement the minimal generator change**

Change only:

```js
const winCmd = `& "${process.execPath}" "${hookPath}"`;
```

- [x] **Step 4: Verify GREEN and regressions**

Run:

```text
node --test --test-name-pattern="PowerShell-safe" test/codex-smoke.test.js
node --test --test-concurrency=1 test/codex-smoke.test.js test/init.test.js test/dual-hook-bridge.test.js
npm run test:dual
git diff --check
```

Expected: all commands exit 0; the two platform-dependent symlink tests may remain skipped.

- [x] **Step 5: Project regeneration boundary**

Regenerate `.codex/hooks.json` only after the target project exists and the user authorizes recovery if its contents were externally deleted. Do not restore Recycle Bin payloads implicitly.

Verified boundary: patched the existing `E:\demoSite\.codex\hooks.json` only; did not restore or mutate Recycle Bin payloads. The target app's `package.json` and `src/` are still absent and remain a separate recovery concern.

- [x] **Step 6: Commit boundary**

Do not commit. Report the verified change and await explicit commit authorization.

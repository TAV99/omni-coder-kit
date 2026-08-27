# Dual AUTO setup state gates — P0 verification

**Date:** 2026-08-26  
**Workspace:** `E:\omni-coder-kit`  
**Status:** Implemented and test-verified in the current working tree; not committed or pushed.

## Outcome

The gap between an approved `om-think` design and durable Dual authority is now an enforced state transition instead of a prompt-only convention:

1. Skill selection/install and planning artifacts remain permitted.
2. Setup is represented by `.omni/sdlc/setup.json` and executed through the shell-free typed runner.
3. One exact legacy mismatch (`native` plus `npm`/`pnpm`/`yarn`/`bun`) is repaired atomically.
4. Any existing setup manifest, including an empty one, requires a matching SUCCESS receipt before plan registration.
5. Once the design is ready, source/build/browser mutation is blocked until `omni_dual_begin` establishes durable authority and the plan is registered.
6. AUTO continues through skill → plan → setup → begin → register → resume without asking for a manual shell fallback.

## Root-cause closures

### `om-think` stopped despite AUTO

The hook previously treated the pre-authority interval as a terminal blocker. The phase gate now distinguishes planning/control-plane work from source mutation. `Stop` requests AUTO continuation once and then respects the recursion guard so it cannot create an infinite hook loop.

### `native` could not resolve `npm`

Package managers are now a separate semantic action kind. The contract rejects package-manager identifiers under `native`; the setup command repairs only the known legacy mismatch, rewrites the manifest atomically, revalidates it, and continues. Ambiguous identifiers and unsafe actions still fail closed.

### Setup success was not durable authority evidence

Plan registration now checks the on-disk setup manifest against a bounded, schema-valid SUCCESS receipt. Missing, stale, corrupt, foreign, or mismatched evidence blocks registration before AGY capability preflight.

### Skill installation was blocked or too broad

The pre-authority allowlist permits the exact AUTO commands (`omni skills`, `omni skills -y`, and canonical remote `omni skills add` sources). It rejects flags outside the contract, shell operators, HTTP sources, local paths, traversal, drive-qualified paths, and extra arguments.

## Verification evidence

### Focused P0 gate

Command:

```text
node --test --test-concurrency=1 test/dual-contracts.test.js test/dual-setup-runner.test.js test/dual-setup-cli.test.js test/dual-hook-bridge.test.js test/dual-daemon-orchestrator.test.js test/workflow-command-contracts.test.js test/init.test.js
```

Result: **263 passed, 0 failed, 1 skipped**.

### Dedicated Dual gate

Command:

```text
npm run test:dual
```

Result: **538 passed, 0 failed, 2 skipped**.

### Full repository gate

Command:

```text
npm test
```

Results:

- Main Node suite: **1,566 passed, 0 failed, 2 skipped**.
- v4 suite: **187 passed, 0 failed, 2 skipped**.
- Exit code: **0**.

### Diff hygiene

`git diff --check` reported no whitespace errors. Git emitted only the repository's existing LF-to-CRLF conversion warnings on Windows.

## Cross-platform qualification

- Direct setup execution remains `shell: false`; argv items are preserved as data.
- Windows resolution covers trusted native executables and PATH-adjacent Node entrypoints while rejecting `.cmd`, `.bat`, and `.ps1` wrappers at the typed boundary.
- POSIX resolution and process-group termination paths are covered by contract/unit tests.
- Paths with spaces and Unicode are covered by integration tests.
- Current live execution was performed on Windows. Linux and macOS behavior is test-qualified by portable contracts, but this verification did **not** perform real-host smoke runs on Linux or macOS.

## Remaining release gate

The repository contains a large combined, pre-existing uncommitted Dual P0 worktree. This verification proves the current combined tree, not an isolated commit. Before release, inspect and stage the intended file set, then run live CLI smoke tests on Windows, Linux, and macOS. No commit, push, publish, or global `npm link` was performed by this verification.

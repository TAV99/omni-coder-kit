# Dual AUTO Authority Daemon P0 — Verification Report

**Verification date:** 2026-08-25  
**Host:** Windows 10 x64, PowerShell, Node.js 24.14.0, npm 11.13.0, Git 2.52.0.windows.1  
**AGY capability:** 1.1.20; exact model `gemini-3.7-flash-high` listed  
**Branch:** `v4`  
**Commit state:** working tree only; nothing staged, committed, pushed, deployed, or globally linked by this verification pass

## Outcome

The P0 authority-daemon implementation, deterministic fake-worker coverage, and the real AI4Teacher Codex/AGY/browser acceptance transaction are green on the current Windows host. The accepted session reached `VERIFIED` with receipt `96536b917b34d2ad9f071653ff6d0115b7015433bb3583665e27cf5aa1eb8a62`.

This completes the current-host P0 acceptance gate. It is not a cross-host or production release qualification: the credential-free GitHub Actions matrix is defined but has not been executed on hosted Windows, Ubuntu, and macOS runners.

## Implemented and locally verified

- The daemon is the hash-chained authority for session, plan, ownership, leases, gates, Codex QC, receipt, and terminal verification.
- Greenfield workspaces use a snapshot baseline without Git initialization or mutation; Git workspaces use the current HEAD.
- Generated Codex integration uses the current `[features] hooks = true`, project-local `hooks.json`, and a stdio `omni_dual` MCP entry materialized with absolute Node/package paths.
- AGY execution uses exact argv with `shell: false`, `windowsHide: true`, bounded time/output, exact `gemini-3.7-flash-high`, and the user-approved `--dangerously-skip-permissions` flag.
- Exact AGY version/model evidence is captured once by daemon preflight, stored durably, and reused by task phases/resume. Injected or forged `PASSED` results without exact evidence are converted to `BLOCKED`.
- Standalone v1 transactions persist capability evidence in `phase.completed`; a new process restores it without writing null metadata or repeating probes. Older transactions use a compatibility probe.
- `VERIFIED` replay checks workspace drift and still fails closed on active or expired unreleased leases.
- Test runners schedule test files serially. This avoids false daemon RPC timeout/connection-reset failures caused by process/port contention while retaining explicit concurrency and race tests inside the suites.
- MCP requests use operation-appropriate bounded timeouts: normal calls allow 15 seconds, while `plan.register` allows 35 seconds for the two-command AGY capability preflight. A live replay now returns one acknowledged result instead of timing out while the daemon continues ambiguously.
- Greenfield daemon startup writes the canonical snapshot-store envelope (`workspace_id`, canonical `workspace_root`, and `content_sha256`) rather than the obsolete partial envelope that made completion diff measurement fail.
- Project-local Codex config omits `[profiles.*]`, which Codex CLI 0.149.1 reports as unsupported at project scope; hooks and the project `omni_dual` MCP remain active.
- Snapshot QC consistently excludes detected generated build outputs (`dist`, `.next`, `build`, and coverage output) while retaining source changes. Advanced workspaces can add strict repository-relative prefixes through `.omni/manifest.json` `snapshotBuildOutputs`; unsafe traversal and oversized policy files fail closed.
- `omni dual status <task-id>` now reads the live authority session first and falls back to the integrity-verified offline ledger after an orderly daemon stop. Greenfield snapshot workspaces no longer fail with `DUAL_NOT_GIT_REPOSITORY` merely to inspect task status.
- Quality-first AGY phases intentionally do not use `--disable-slash-commands`: Omni optimizes Codex context only, leaves AGY unbudgeted, and enforces depth through strict research/self-review/challenge artifacts. Exact argv coverage and a fresh live transaction are green.
- Daemon/hook test cleanup now awaits shutdown and explicitly stops the SessionStart-bootstrap workspace. A full Dual rerun left zero matching temporary `omni-daemon.js` processes; 41 leaked test daemons from earlier runs were terminated after their exact temp-workspace command lines were verified.

## Current-host Codex hook and MCP smoke

The generated Dual project was trusted through the normal Codex trust UI. Fresh runtime evidence on this Windows host proved:

- all five generated hooks were active and `SessionStart` attached to daemon session `a2c31511-b860-474e-a3e9-708343af13ba`;
- `codex mcp list` loaded the project `omni_dual` server, and an MCP SDK client listed all five tools and read the same daemon session;
- idempotent `omni_dual_register_plan` returned `registered: true`, state `EXECUTING`, without an ambiguous client timeout;
- `PreToolUse` denied a Codex source mutation while the task was AGY-owned and unleased;
- the first incomplete `Stop` returned `decision: block`, while `stop_hook_active: true` returned only a loop-guard message;
- after an orderly daemon stop, the same mutation failed closed with `Dual daemon is not running or unreachable`.

The smoke project's Codex trust/hook hashes and Antigravity trusted-workspace/project registrations were removed after the run. The disposable temp directory itself may remain because the local command policy prevented recursive deletion; it has no active daemon or trust registration.

## AI4Teacher live acceptance

The greenfield workspace `E:\DemoSite` completed a real AGY-assisted rework transaction:

- Session: `7892863c-f3c8-4b60-8c44-0cc4fb7713ac`; task: `AI4T-RESPONSIVE-REWORK`.
- AGY 1.1.20 ran scout, implement, scope, and read-only review through registered project `8ac324ea-d79b-4c37-8301-cbddc3f0883f`, exact model `gemini-3.7-flash-high`, high effort, and the approved `--dangerously-skip-permissions` mode.
- AGY changed only `src/App.css` and `src/App.test.tsx`; the final diff fingerprint was `99d2c330113bcb6ff3c5e17fad5eb86a98a1204e23d9df532dce30129477ad1b`.
- Codex independently verified 10/10 application tests and the TypeScript/Vite production build.
- Real Chrome QA returned HTTP 200 at 390, 768, 1024, and 1440 px. At every viewport, `html/body clientWidth === scrollWidth`; reduced-motion matched and collapsed animation/transition duration to `1e-05s` with `scroll-behavior: auto`.
- Three durable quality cycles and the mandatory UI gate passed. Authority state is `VERIFIED`, all leases are released, blockers are empty, and the final receipt is recorded above.

The first live attempt correctly failed its review-mutation fingerprint because Codex wrote browser artifacts during AGY review. Those artifacts were recoverably archived, and the clean rework transaction was run without concurrent workspace mutation. This confirms the guard was enforcing ownership rather than producing a false AGY failure.

## Deterministic gates

| Gate | Result |
|---|---|
| `node -c bin/omni.js` | PASS |
| `npm audit --audit-level=high` | PASS, 0 vulnerabilities |
| `npm run test:dual` | PASS, 529 tests: 527 pass, 0 fail, 2 platform skips |
| Init/Codex/daemon CLI/MCP/hook focused regression | PASS, 155 tests: 155 pass, 0 fail |
| `npm run typecheck:v4` | PASS |
| `npm run build:v4` | PASS |
| `npm test` core | PASS, 1,552 tests: 1,550 pass, 0 fail, 2 skips |
| `npm test` v4 | PASS, 189 tests: 187 pass, 0 fail, 2 skips |
| `git diff --check` | PASS; LF-to-CRLF warnings only |
| Live `agy --version` / `agy models` | PASS: 1.1.20 and exact required model listed |

The skips are environment/opt-in cases, not false-green replacements for mandatory assertions. Automated fake-adapter tests prove deterministic cross-platform product behavior; the AI4Teacher transaction additionally proves the real model/browser path on the current Windows host. Neither proves hosted macOS/Linux execution.

## Cross-platform CI definition

`.github/workflows/dual-cross-platform.yml` is credential-free and runs `npm ci` plus `npm run test:dual` on:

- `windows-latest`, `ubuntu-latest`, and `macos-latest`;
- Node.js 20 and 24;
- fake AGY fixtures only.

**Gate state:** definition inspected locally; hosted matrix execution is **UNVERIFIED** in this report.

## Static execution audit

The Dual P0 runtime (`lib/dual`, `lib/commands/dual.js`, `bin/omni-daemon.js`, `bin/omni-hook.js`, Codex overlay, and Codex+AGY templates) contains no `shell: true`, `cmd.exe /c`, PowerShell orchestration, or `ProcessStartInfo.Arguments`. `codex_hooks` appears only in fail-closed detection of the deprecated feature name.

A broad repository scan also finds two pre-existing, out-of-scope groups:

- `lib/harness/tools/shell.js` intentionally supports legacy string commands through a platform shell;
- Claude/Gemini/Cursor overlay workflow copies still mention `setup.sh`.

Those matches are not on the new Dual daemon path and were not silently described as zero findings. They require a separate migration decision if Omni intends to remove every legacy shell surface repository-wide.

## Runtime and recovery boundaries

- Discovery/lock: `.omni/runtime/dual/daemon.json`, `.omni/runtime/dual/daemon.lock`.
- Authority ledger and snapshots: `.omni/runs/dual-authority/`.
- Task transaction artifacts: `.omni/codex-gemini/runs/<task-id>/`.
- Setup manifest/receipt: `.omni/sdlc/setup.json`, `.omni/runs/dual-setup/receipt.json`.
- Inspect/recover with `omni dual daemon status`, `omni dual daemon start`, `omni dual status <task-id>`, and `omni dual resume <task-id>`.
- Stop safely with `omni dual daemon stop`.
- Promote a verified greenfield snapshot only after creating the intended Git commit, using `omni dual baseline promote`; the command revalidates receipt, snapshot tree, clean worktree, and daemon shutdown before appending the promotion event.
- Never delete or hand-edit authority/runtime files as a normal repair. Corrupt or foreign ledger/lock/discovery data fails closed and must be inspected before any bounded recovery.

## Remaining release gates

1. Execute the hosted Windows/Ubuntu/macOS CI matrix on Node.js 20 and 24.
2. Run at least one real AGY transaction on macOS and Linux if Omni requires live-host qualification beyond automated portability coverage.

## 2026-08-25 quality-first communication verification

- AGY route budget is `null`; argv uses exact `gemini-3.7-flash-high`, effort `high`, permission bypass, no context-suppression flag, and a derived 20-minute print timeout.
- Scout/implement/review contracts require deep research, alternatives/failure modes, three self-review checks, three independent review checks, and a challenge summary.
- Empty/malformed/schema-invalid/timeout/network/spawn/non-zero output is retryable up to three attempts with a bounded correction hint. Integrity and authority failures remain outside the retry set.
- Codex native skills consume semantic artifacts first, reserve raw output for diagnostics, and prohibit source/build/browser writes until AGY lease release.
- Real greenfield Windows dogfood `QUALITY-CLAMP-01` produced 3 research entries, 2 alternatives, 2 failure modes, 3 self-review checks, 3 independent review checks, and an explicit counterargument. Codex independently reran `node --test` (2/2 pass), completed three quality cycles, and received verified receipt `3794ca1294b117cb7c6cee69236d0e39bfde5a7739986417dbb2bd4880d4fd4a`.
- The live run exposed stale intermediate status and repeated shared-source skill installation. Regression tests now derive `AGY_IN_PROGRESS`/`AWAITING_CODEX_QC` from leases and pass exact `--skill <name>` rather than `*`.
- Dogfood daemon was stopped. No commit, push, global relink, or deploy was performed.

Current status is **P0 implementation and current-Windows-host live acceptance complete**. It is not yet alpha/beta/production release-qualified across all supported hosts.

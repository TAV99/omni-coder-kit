# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.0] — 2026-11-12

### Changed
- **Behaviour change — integrate waits for a person.** Isolated QC that passes no longer writes into the source by itself: it stops at `AWAITING_HUMAN_APPROVAL` until someone runs `omni squad approve integrate-<task>` on a terminal and types the code shown. This applies to every dual project, squad or not; AUTO never skips it. Revision promotion uses the same gate. Projects with `.omni/squad/pipeline.yaml` also gate spec coverage and the plan (AUTO may skip those when marked `auto_ok`).
- Codex–AGY workflows share a controller reference across native entrypoints, with exact isolated QC, context-reply, correction and dependency contracts. Generated integration text respects the selected pairing and configured worker model.

### Removed
- **Breaking — the old SDLC harness is gone.** `omni run` and its `gate`, `log`, `stats` and `accept` subcommands, `lib/harness/` and the harness-only debate prompt were removed; squad (`omni squad`, `omni ui`) is the only orchestration path. Chat workflows (`>om-*`) are unchanged.

### Fixed
- First real-project runs (DemoOm): nested daemon CLI turns skip omni hooks; recovery ignores omni state on a git baseline; Stop returns to the user before a plan exists; the write fence accepts in-tree dangling symlinks, never turns a pre-launch refusal into a terminal failure, and classifies it as a harness launch failure; an undelivered context reply is re-dispatched; the implement brief states the decision-log contract; quoted validation commands match their registered argv; a project without `package.json` has no npm audit gate; large MCP responses degrade to compact JSON.
- Isolated finalization preserves failure evidence after lease expiry and settles only the current execution with verified tracked-child close evidence; stale owner/revision/lease results cannot overwrite a newer attempt. Unmanaged dependencies fail before result collection scans them.
- Fresh unborn Git repositories use verified snapshot bootstrap, and pre-authority interview stops no longer force premature continuation; safe task-status diagnostics retain full process-handle guidance.
- Isolated dispatch no longer inherits the source AGY project binding. Private dependency fingerprints use bounded reads for native binaries, with readiness checks before dispatch and explicit resource limits.
- Exact opt-in Stitch operation grants are preserved through MCP and authority replay; durable reservations prevent automatic duplicate mutations. Failed preparation no longer loops AUTO continuation when no independent work can run.
- Authority task metadata survives replay; `run`/`resume` recognize authority tasks rather than fabricating legacy transactions.
- Standalone Codex cook preserves uncommitted changes without requiring automatic commit/stash or undeclared dependency installation.

### Added
- **omni squad.** Role-based agent team: a runtime registry (claude, codex, agy), role files with CLI/model/effort bindings, a declared pipeline with human gates (`omni squad approve` on a terminal), per-role skill mounts, and reviewer/worker roles. `omni dual` stays as the dual preset.
- **omni ui.** Local web page for a squad project: roles, tasks, gates, timeline and the orchestrator terminal.
- Orchestrator receipts carry a typed `next_action`; `omni skills doctor` and `omni ui` warn when the orchestrator CLI does not trust the project yet; a macOS sleep guard holds `caffeinate` while a worker lease is held.
- Opt-in isolated worker snapshots, hash-bound handoffs, controller QC/integration journals, dependency waits, durable scout questions/replies, and bounded correction attempts. Live-host and release qualification remain pending; these entries do not announce a published release.

## [3.1.1] — 2026-09-03

### Added
- **Configurable AGY Worker Model in Dual Flow (`omni dual`)**:
  - Full support for configuring custom Antigravity (`agy`) models and reasoning efforts for the worker role in Dual Flow.
  - Deterministic 4-level precedence resolution: CLI option (`--worker-model`, `--worker-effort`) > Environment variables (`OMNI_DUAL_WORKER_MODEL`, `OMNI_DUAL_WORKER_EFFORT`) > Manifest configuration (`.omni/manifest.json` -> `workerModel`, `workerEffort`) > Safe default (`gemini-3.7-flash-high`, effort `high`).
  - Added dedicated test suite `test/dual-custom-model.test.js` covering dynamic model resolution, preflight checks, and execution isolation.

### Fixed
- **Stale Workflow Template Command Cleanup**:
  - Replaced legacy `omni auto-equip` and `omni equip` commands with canonical `omni skills -y` and `omni skills add` across local `.omni/workflows/skill-manager.md` and candidate overlays.
  - Added regression test guard in `test/workflow-command-contracts.test.js` enforcing zero stale command references in `.omni/workflows/`.
- **Daemon Orchestrator Scoping & Evidence Validation**:
  - Resolved variable scope leak in `daemon-server.js` handoff evaluation to ensure clean task verification.
  - Hardened capability evidence validation in `capability-preflight.js` and `orchestrator.js` against forged worker models.

## [3.1.0] — 2026-08-28

### Added
- **Dual AUTO Authority Daemon (`omni dual`)**:
  - Full cross-platform orchestration coordinating **Codex** (Architect, Router, Final QC) and **Gemini 3.7 Flash High** via `agy` (Fast Worker).
  - Authority Ledger with hash-chain receipts for durable task ownership, lease-based concurrency locking, and immutable audit logs.
  - Native Codex Hook Bridge (`.codex/hooks.json`) and bidirectional stdio MCP Server for token-efficient summaries, context briefing, and quality gating.
  - Idempotent Setup Runner (`setup.json`) automating pre-task environment and dependency initialization.
  - Baseline Snapshot Store & Git Promotion Protocol protecting source tree integrity until final QC verification.
  - 3-tier Adaptive Visual QA & UI Quality Gate integration.
- **Dual CLI Subcommands**:
  - `omni dual daemon start|status|stop` — Daemon lifecycle and health management.
  - `omni dual bootstrap --json` — Bootstrap authority session from planning graphs.
  - `omni dual setup run` — Idempotent environment setup execution.
  - `omni dual baseline promote` — Safe git promotion after verified QC completion.
- **Dual Test Suite**:
  - 24 dedicated test suites in `test/dual-*.test.js` covering authority store, hook bridge, MCP server, quality ledger, snapshot baseline, daemon orchestrator, and adversarial review.
- **Updated Documentation**:
  - Comprehensive documentation for Dual AUTO mode and `omni dual` workflows in `README.md`.

### Changed
- `package.json` version bumped to `3.1.0`.
- Fresh release suite: 1,595 passed, 2 platform-conditional skipped, 0 failed (1,597 tests total).

## [3.0.0] — 2026-07-20

### Breaking
- Removed deprecated **hidden CLI aliases** that printed a deprecation hint in 2.7.x. Use the canonical commands instead:
  - `omni equip` → `omni skills add`
  - `omni auto-equip` / `omni status` → `omni skills`
  - `omni skills:doctor` → `omni skills doctor`
  - `omni gate` → `omni run gate`
  - `omni trace` → `omni run log`
  - `omni stats` → `omni run stats`
  - `omni onboard` → `omni init --onboard`
- Chat workflows (`>om-*`) are unchanged.

### Changed
- CLI entry (`bin/omni.js`) no longer depends on `chalk` for deprecation wrappers.
- `.gitignore` blocks accidental Next.js / OS artifacts (`.next/`, `out/`, `next-env.d.ts`, `.DS_Store`, `.agents_backup/`).
- Internal: drop unused public export of `detectMcpServers` from `lib/init/strategies.js` (still used privately).

### Added
- `CHANGELOG.md` and `RELEASE.md` for maintainers.
- README migration table 2.x → 3.0.
- Release prep: branch audit + website-extract runbook (CLI package stays free of the Next marketing app).

### Notes
- Git tags lagged package versions in the 2.7.x line (package reached 2.7.2 while latest tag was `v2.6.1`). From 3.0.0 onward, every npm publish should have a matching `vX.Y.Z` tag.
- Marketing website remains on branch `website` and is **not** part of the npm package; extract to a separate repo before merging anything into `main`.

## [2.7.2] — prior

### Added
- `omni agent-files` hide/show via `.gitignore` (documented in README).

### Notes
- Lineage includes harness Phase 0–4 (acceptance loop), simplified 5-group CLI, Antigravity overlay, multi-IDE init. See git history for full detail.

## [2.6.2] — prior
### Added
- Phase-4 ACCEPTANCE loop, simplified CLI surface, `--yolo` host-cli permissions flag.

## [2.6.1] — prior
### Changed
- Antigravity overlay rewritten to verified `agy` schema + CLI-aware init map.

## [2.6.0] — prior
### Added
- Agent harness Phases 0–3 and skills upgrades.

[Unreleased]: https://github.com/TAV99/omni-coder-kit/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/TAV99/omni-coder-kit/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/TAV99/omni-coder-kit/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/TAV99/omni-coder-kit/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/TAV99/omni-coder-kit/releases/tag/v3.0.0

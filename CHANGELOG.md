# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Dual & Architecture Documentation**:
  - Split comprehensive documentation into dedicated `README_V3.md` (v3.x manual) and `README_V4.md` (v4 reliability harness design).
  - Added `README_V3.md` and `README_V4.md` to package distribution files.

### Changed
- `package.json` version bumped to `3.1.0`.
- Verified 100% test pass rate across 925 v3 test cases and 189 v4 contract test cases.

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

[Unreleased]: https://github.com/TAV99/omni-coder-kit/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/TAV99/omni-coder-kit/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/TAV99/omni-coder-kit/releases/tag/v3.0.0

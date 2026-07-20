# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/TAV99/omni-coder-kit/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/TAV99/omni-coder-kit/releases/tag/v3.0.0

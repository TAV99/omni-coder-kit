# Dual single bootstrap controller — verification report

Date: 2026-08-27

## Implemented

- Added strict `.omni/sdlc/dual-plan.json` contract with a complete versioned implementation graph.
- Added `omni dual bootstrap --json` as the single AUTO control-plane entrypoint:
  - validates the graph before side effects;
  - executes/reuses typed setup before authority creation;
  - re-hashes the graph after setup;
  - creates the post-setup baseline;
  - registers the real graph once;
  - resumes the eligible AGY slice.
- Planning artifacts and installed skill files remain outside the execution ledger; temporary `bootstrap-plan-artifacts` tasks are forbidden.
- Added fail-closed adoption for legacy planning-only sessions with setup-receipt and bounded-drift verification, archival, and rollback on fresh-authority startup failure.
- Added real `omni skills -y/--yes` CLI support to match the hook and workflow contract.
- Expanded the single AGY slice to 1-10 exact files while retaining one immutable-baseline slice per session.
- Rejected multiple AGY slices and setup/planning/final-QC/review/verification pseudo tasks before daemon side effects.
- Updated native `$om-think`, task-planning, coder-execution, and Codex-Gemini workflow guidance to use only the controller during AUTO bootstrap.

## AGY contribution and review

- AGY implemented and tested `omni skills -y/--yes` in its isolated file scope.
- AGY adversarial review identified two confirmed bootstrap issues:
  - Git legacy diffs needed normalization from `{ path }[]` to `string[]`.
  - Legacy adoption needed parity for `.agents/.codex/.omni` skill planning paths.
- Both findings received regression tests before the fixes were retained.
- Unproven or out-of-scope proposals (direct pre-authority package edits and blanket hook timeout increases) were not adopted.

## Automated verification

- Focused bootstrap/routing/workflow gate: 214 pass, 0 fail.
- `npm run test:dual`: 558 pass, 0 fail, 2 conditional Windows symlink skips.
- `npm test`:
  - v3: 1,588 pass, 0 fail, 2 conditional skips.
  - v4: 187 pass, 0 fail, 2 conditional skips.
  - overall exit code: 0.

## Live DemoSite dogfood

- The controller archived stale bootstrap session `9ca2d366-46e4-4dd0-9694-05640414c007` without deleting its ledger.
- It created post-setup session `8a564a97-453b-4c88-8379-3a2a02162532`, registered the real graph, routed `ai4teacher-implementation` to AGY, and acquired/renewed the AGY lease.
- AGY completed `scout → spec → route → implement → scope → review`, returned `APPROVE`, and released the lease with `agy_reviewed_awaiting_codex_qc`.
- Independent Codex checks in `E:\demoSite`:
  - `npx tsc --noEmit`: exit 0.
  - `npm run test -- --run`: 8 pass, 0 fail.
  - `npm run build`: exit 0.
  - Chrome/Playwright runtime: no horizontal overflow at 390/768/1024/1440; required form labels and CTA rendered; no HTTP response >=400; reduced-motion max animation/transition duration 0.01ms and scroll behavior `auto`.
- The dogfood session is intentionally not reported VERIFIED: its pre-fix graph included a Codex final-QC pseudo task. The new contract now rejects this graph shape before authority creation, but the existing ledger is preserved as incident evidence rather than rewritten.

## Current qualification boundary

- The CLI has now proven real bootstrap → AGY execution → AGY review → Codex QC handoff on Windows.
- It has not yet proven a clean new session reaching `session.verified` under the corrected no-QC-pseudo-task graph.
- Linux and macOS paths remain automated-tested, not live-host-smoked.
- P0 supports one cohesive AGY implementation slice (1-10 exact files) per immutable-baseline session. Multi-slice AGY execution requires per-task baseline promotion and remains future architecture work.
- No commit, push, release, or deployment was performed.

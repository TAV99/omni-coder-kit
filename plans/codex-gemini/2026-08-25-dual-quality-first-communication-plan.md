# Dual Quality-First Communication Implementation Plan

**Goal:** Maximize AGY research/implementation quality, minimize only Codex context, and automatically recover bounded technical failures without weakening authority or integrity.

## Completed work

- [x] Extend Scout, Evidence, and Review contracts with mandatory depth evidence.
- [x] Strengthen AGY phase prompts for repository/official-source research, alternatives, failure modes, self-review, and challenge review.
- [x] Remove AGY context suppression, set route token budget to `null`, and derive the long print timeout from the outer bound.
- [x] Retry up to three technical attempts using safe correction hints while preserving immutable attempt artifacts.
- [x] Encode semantic-first Codex context use and lease-based phase isolation in generated native skills and `$om-think` routing.
- [x] Correct authority status during active AGY work and the released Codex-QC handoff.
- [x] Stop repeated shared-source skill installation by selecting one exact skill per invocation.
- [x] Run focused TDD, full Dual/core/v4 gates, audit/typecheck/build/diff checks, and one real greenfield AGY dogfood transaction.
- [x] Stop the dogfood daemon and preserve verified receipt evidence.

## Remaining external qualification

- [ ] Run the credential-free hosted Windows/Ubuntu/macOS CI matrix.
- [ ] Run real AGY transactions on Linux and macOS if live multi-host qualification is required.
- [ ] Commit, globally relink, push, or release only after separate user authorization.

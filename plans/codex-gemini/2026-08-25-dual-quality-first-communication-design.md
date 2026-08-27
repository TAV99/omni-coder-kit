# Dual Quality-First Communication Design

**Date:** 2026-08-25  
**Status:** Implemented; deterministic and current-Windows live verification complete

## Objective

Make Codex and AGY cooperate without technical deadlocks while optimizing tokens only for Codex. AGY receives the full supported worker context and must prove source-grounded research, alternatives, failure analysis, implementation self-review, and independent challenge review.

## Locked boundaries

- Exact worker: `gemini-3.7-flash-high`, effort `high`, approved `--dangerously-skip-permissions`.
- Omni sets no AGY token budget and does not suppress AGY skills/context.
- Codex owns architecture, routing, final QC, receipts, commit, push, and deploy authority.
- Technical transport/model-output failures retry automatically; scope, authority, ledger, baseline, forbidden mutation, and mandatory-gate failures remain fail-closed.
- Process execution stays shell-free and portable across Windows, Linux, and macOS.

## Architecture

### Quality-first AGY phases

- Scout requires at least two `research_trace` entries, two `alternatives_considered`, and one `failure_modes` entry.
- Implement requires at least three `self_review.checks` plus `remaining_risks`.
- Review requires at least three `review_checks` plus a `challenge_summary` containing the strongest counterargument.
- The strict JSON contracts reject shallow claims before handoff.

### Automatic recovery

Each AGY phase gets at most three technical attempts. Timeout, network error, spawn/non-zero exit, empty output, malformed output, and schema-invalid output receive a bounded correction hint. Immutable input/schema and raw attempt evidence are preserved; safety/integrity failures never enter this retry loop.

### Token and ownership isolation

- AGY route artifacts use `token_budget: null`; the runner derives a 20-minute print window from a bounded outer timeout.
- Codex consumes `context.json`, `spec.json`, `evidence.json`, `review.json`, and bounded MCP summaries on the success path.
- Raw stdout/stderr is diagnostic-only for failure, correlation/hash mismatch, or crash recovery.
- Codex performs no source/build/browser writes during an active AGY lease and begins QC only after durable lease release.

### Operator clarity

- Authority status derives `AGY_IN_PROGRESS` from an active lease and `AWAITING_CODEX_QC` from the released review handoff instead of displaying stale `ROUTED` state.
- Universal skill installation selects the requested skill name rather than reinstalling every skill exposed by a shared source on each loop.

## Acceptance boundary

Automated tests and a real Windows AGY transaction qualify the current host. Hosted Windows/Ubuntu/macOS matrix execution and real AGY transactions on Linux/macOS remain separate release gates.

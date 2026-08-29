# Omni v4 Milestone 6 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete the remaining deterministic Milestone 6 control plane and leave paid/live external qualification at explicit evidence gates.

**Architecture:** Extend existing strict benchmark/recovery contracts with small focused modules for aggregation, comparison, migration, and smoke evidence. Every mutation is isolated, checksummed, and explicitly authorized; reports distinguish expectation-match from reliable accepted completion.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Zod 4, `node:test`, Git CLI.

## Global Constraints

- TDD red-green-refactor for every behavior change.
- No external repository mutation, paid model call, push, deploy, tag, release, or compatibility promotion.
- Preserve `shell:false`, typed argv, bounded output, pinned revisions, and fail-closed outcomes.
- Missing metrics remain unavailable, never zero.

### Task 1: External dogfood contracts

**Files:** `src/v4/benchmark/contracts.ts`, `external-binding.ts`, `external-workspace.ts`, `runner.ts`, `benchmarks/v4/manifest.json`, matching benchmark tests.

- [ ] Add failing contract/workspace/runner tests for case 16/17, subdirectory cwd, safe prefixes, output bounds, toolchain/dependency enforcement, and generated Python paths.
- [ ] Run targeted tests and confirm expected failures.
- [ ] Implement the smallest generic contract and staging changes.
- [ ] Run targeted benchmark tests to green and update candidate preflight evidence.

### Task 2: Chaos and recovery qualification

**Files:** `src/v4/storage/event-store.ts`, `artifact-store.ts`, `src/v4/core/recovery.ts`, `src/v4/testing/fault-scenarios.ts`, chaos/recovery/storage tests.

- [ ] Add failing tests for truncated tails, post-transition tamper, protected-side-effect reconciliation, repeated timeout, network disconnect, CLI drift/nonzero, and injected persistence faults.
- [ ] Run targeted tests and confirm contract failures.
- [ ] Add atomic/durable persistence, full lineage reverification, reconciliation receipt validation, and bounded retry behavior.
- [ ] Run the complete chaos matrix repeatedly and assert zero false success.

### Task 3: Reliability and profile aggregation

**Files:** create `src/v4/benchmark/aggregate.ts`, `profile.ts`; update `runner.ts`, `report.ts`; add aggregate/profile tests.

- [ ] Add failing tests for applicable denominator, evidence completeness, 89.99/90.00 threshold, repeated-run percentiles, and unavailable context metrics.
- [ ] Implement strict schemas and pure deterministic aggregation.
- [ ] Integrate JSON/Markdown output without changing individual-case semantics.
- [ ] Run targeted report/benchmark tests to green.

### Task 4: V3/V4 comparison

**Files:** create `src/v4/benchmark/version-comparison.ts`; add comparison tests and representative v3 fixtures.

- [ ] Add failing tests for corpus mismatch, normalized unavailable fields, false-success deltas, and reproducible JSON/Markdown output.
- [ ] Implement v3 event-summary adapter and normalized comparison.
- [ ] Verify identical persisted inputs yield byte-identical reports.

### Task 5: Migration assistant

**Files:** create `src/v4/migration/{contracts,inventory,backup,migrator,report}.ts`; add CLI entry/script and migration tests/fixtures.

- [ ] Add failing tests for non-mutating dry-run, path/symlink escape, collisions, verified backup-before-write, interrupted apply, tampered backup, and byte-identical rollback.
- [ ] Implement inspect/plan/backup/apply/verify/rollback with atomic writes and SHA-256 manifests.
- [ ] Add explicit CLI modes; default to dry-run.
- [ ] Run migration tests including rollback comparison.

### Task 6: Compatibility smoke evidence

**Files:** create reusable smoke/evidence modules under `src/v4/compatibility/`; add CLI/script, tests, and docs.

- [ ] Add failing tests for dated evidence, three approval signals, correlation/mutation facts, stale/mismatched promotion rejection, and no automatic manifest edit.
- [ ] Extract reusable smoke runner from test-only code and implement artifact rendering.
- [ ] Implement a separate promotion validator that returns a plan but does not write by default.
- [ ] Run deterministic smoke contract tests; do not execute paid/deferred hosts.

### Task 7: Quality, acceptance, and docs

- [ ] Run three quality cycles with P0 secrets/audit, P1 typecheck, P2 build, P3 full tests.
- [ ] Run fresh adversarial reviews of public interfaces, migration safety, and recovery invariants.
- [ ] Grade every requirement into `.omni/sdlc/conformance.md`; leave live-only requirements blocked when evidence is absent.
- [ ] Update `README_V4.md`, compatibility docs, roadmap status, and `.omni/sdlc/test-report.md` from actual evidence.

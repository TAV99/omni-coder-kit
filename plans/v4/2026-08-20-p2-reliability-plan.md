# Omni v4 P2 Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a fail-closed quality, verification, acceptance, bounded-repair, and recovery subsystem satisfying `.omni/sdlc/requirements.md` R1-R46 without changing P0/P1 behavior.

**Architecture:** Keep `RunController` responsible only for durable run state. A new `QualityCoordinator` owns configuration, requirements, gates, verdicts, repair, and bundles; a separate `RunOrchestrator` persists typed decisions and requests only causally authorized routes. P2 executes gates sequentially through the existing `ProcessRunner`; P3 may replace scheduling but not gate semantics.

**Tech Stack:** Node.js 20+, TypeScript strict mode, Zod 4, `node:test`, `node:assert/strict`, SHA-256 from `node:crypto`, atomic filesystem writes, existing P0/P1 event and process abstractions.

## Global Constraints

- Normative contract: `plans/v4/2026-08-20-p2-reliability-spec.md` and R1-R46 in `.omni/sdlc/requirements.md`.
- Work task-by-task in order. For each behavior, write the named failing test first, confirm RED for the expected reason, add the minimum implementation, then confirm GREEN.
- Use `@skill:test-driven-development` for every task; use `@skill:systematic-debugging` for unexpected failures and `@skill:verification-before-completion` before any completion claim.
- Preserve existing event payloads, P0/P1 replay, adapter contracts, and v3 behavior.
- Do not import from `lib/harness` into `src/v4`.
- Do not execute raw `test:` text. Only validated `.omni/v4/quality.json` `command` plus `args` may reach `ProcessRunner`, always with `shell: false`.
- Treat missing configuration, missing/corrupt evidence, skipped mandatory gates, and inconclusive mandatory gates as non-success.
- Do not put quality parsing, command execution, or acceptance logic into `RunController`.
- Keep public results and decisions as discriminated unions; validate untrusted disk, adapter, and configuration data once at their boundary.
- Do not commit, push, tag, publish, or deploy. At checkpoints, report only the suggested commit message.
- Do not overwrite `.omni/sdlc/todo.md`; this plan is the execution tracker.

## Baseline and Completion Commands

Run before Task 1 and record the result:

```powershell
npm run typecheck:v4
npm run test:v4
```

Expected baseline on 2026-08-20: typecheck passes; v4 tests report 95 total, 93 passed, 2 platform/live skips, 0 failed. If the baseline differs, stop and report the exact difference before changing code.

Run after every task:

```powershell
npm run typecheck:v4
npm run test:v4
```

Run at the P2 exit gate:

```powershell
npm run build:v4
npm test
git diff --check
```

## Locked Interfaces and File Map

Create:

```text
src/v4/contracts/quality.ts
src/v4/quality/errors.ts
src/v4/quality/config.ts
src/v4/quality/requirements.ts
src/v4/quality/gate-registry.ts
src/v4/quality/gate-runner.ts
src/v4/quality/acceptance-engine.ts
src/v4/quality/agent-judge.ts
src/v4/quality/repair-policy.ts
src/v4/quality/evidence-bundle-store.ts
src/v4/quality/quality-coordinator.ts
src/v4/orchestration/run-orchestrator.ts
```

Modify only as required:

```text
src/v4/contracts/event.ts
src/v4/contracts/index.ts
src/v4/core/transitions.ts
src/v4/core/reducer.ts
src/v4/core/recovery.ts
src/v4/storage/event-store.ts
src/v4/index.ts
```

The public types and schemas must match section 5 of the approved P2 spec. Do not rename `GateId`, `RequirementId`, `QualityCycleId`, `QualityEvidenceId`, `GateDefinition`, `GateResult`, `QualityEvidence`, `RequirementRecord`, `RequirementVerdict`, or `QualityDecision` without updating the approved spec first.

## Pre-P2 Integration Anchors

Use these anchors from the approved baseline before editing; re-run `rg -n` if earlier tasks move them:

| Responsibility | Current anchor | P2 rule |
|---|---|---|
| Event variants/schema | `src/v4/contracts/event.ts:154`, `:168`, `:336` | Add variants; do not alter existing payloads |
| Normal phase transitions | `src/v4/core/transitions.ts:10`, `:33` | Add only four quality routes |
| Deterministic replay reducer | `src/v4/core/reducer.ts:36` | Quality events must replay without console state |
| History validation/store | `src/v4/storage/event-store.ts:51`, `:162`, `:286` | Enforce causal route references before replay |
| Controller boundary | `src/v4/core/controller.ts:22` | Keep config/parser/process logic outside |
| Recovery | `src/v4/core/recovery.ts:1` | Extend analysis; preserve P0/P1 decisions |
| Process abstraction | `src/v4/process/types.ts:40` | All commands use injected `ProcessRunner` |
| Public barrel | `src/v4/index.ts:1` | Export only stable P2 interfaces |

---

## Task 1: Quality Contracts and Stable Errors

**Requirements:** R2, shared foundation for R9-R46
**Skills:** `@skill:api-and-interface-design`, `@skill:test-driven-development`

**Files:**

- Create: `src/v4/contracts/quality.ts`
- Create: `src/v4/quality/errors.ts`
- Modify: `src/v4/contracts/index.ts`
- Modify: `src/v4/index.ts`
- Create: `test/v4/quality-contracts.test.ts`

- [ ] Add `four_state_gate_result` as a table test for the four valid statuses and reject a fifth value.
- [ ] Add strict-schema tests rejecting unknown properties, invalid timestamps, negative durations, empty IDs, and invalid status-specific fields.
- [ ] Run `npx tsx --test test/v4/quality-contracts.test.ts`; confirm RED because quality contracts do not exist.
- [ ] Implement branded-ID parsers and strict Zod schemas for all P2 public contracts.
- [ ] Model status-specific requirements as a discriminated union so `skipped` requires `reason`, and `inconclusive` requires both `reason` and `failureSignature`.
- [ ] Implement `QualityErrorCode` with exactly the stable P2 codes from spec section 14 and a `QualityError` carrying `code`, `message`, and optional safe details.
- [ ] Export types and schemas through both contract barrels.
- [ ] Run the focused test, then both standard v4 commands.

Expected: all contract variants parse only valid values; TypeScript narrows variants without casts; no environment or secret field exists on `QualityEvidence`.

Suggested checkpoint: `feat(v4): add strict quality contracts and errors`

## Task 2: Requirements Loader and Strict Quality Configuration

**Requirements:** R4-R11
**Skills:** `@skill:test-driven-development`, `@skill:api-and-interface-design`

**Files:**

- Create: `src/v4/quality/requirements.ts`
- Create: `src/v4/quality/config.ts`
- Create: `src/v4/quality/gate-registry.ts`
- Create: `test/v4/requirements.test.ts`
- Create: `test/v4/quality-config.test.ts`

- [ ] Write the named tests `preserves_requirement_text`, `rejects_duplicate_ids`, `rejects_malformed_line`, and `never_executes_test_text`.
- [ ] Inject a throwing fake `ProcessRunner` into the no-execution test; loading Markdown must never call it.
- [ ] Write `strict_versioned_config`, `missing_config_fails_closed`, and `invalid_config_fails_before_execution` with a call counter proving zero commands started.
- [ ] Add cases for `[ ]`, `[x]`, `[!]`, exact trimmed `test: agent`, hard-test metadata, unsupported markers, empty text, missing separators, duplicate gate IDs, unknown requirement IDs, invalid timeout/repair limit, extra keys, and project-root escape.
- [ ] Confirm both focused test files are RED.
- [ ] Implement `loadRequirements(markdown: string): readonly RequirementRecord[]`; preserve the text field verbatim between separators and never interpret hard-test prose as executable data.
- [ ] Implement `QualityConfigSchema` and `loadQualityConfig(projectRoot)` with `schemaVersion: 1`, default summary size, and repair limit constrained to 0..2.
- [ ] Resolve `requirementsPath` and every gate `cwd` against a canonical project root; reject any resolved path outside it.
- [ ] Implement `GateRegistry` to validate requirement mappings and dependency references before execution.
- [ ] Normalize all missing/invalid cases to `QUALITY_CONFIG_MISSING`, `QUALITY_CONFIG_INVALID`, `REQUIREMENTS_MISSING`, or `REQUIREMENTS_INVALID`.
- [ ] Run focused tests and standard v4 commands.

Expected: config and requirements are fully validated before a runner is invoked; raw Markdown can never become argv.

Suggested checkpoint: `feat(v4): load quality config and requirements safely`

## Task 3: Quality Event Protocol, Replay, and Routes

**Requirements:** R31-R33
**Skills:** `@skill:test-driven-development`, `@skill:api-and-interface-design`

**Files:**

- Modify: `src/v4/contracts/event.ts`
- Modify: `src/v4/core/transitions.ts`
- Modify: `src/v4/core/reducer.ts`
- Modify: `src/v4/storage/event-store.ts`
- Create: `test/v4/quality-replay.test.ts`
- Modify: `test/v4/contracts.test.ts`
- Modify: `test/v4/transitions.test.ts`

- [ ] Add `route_causation`, `rejects_invalid_cause`, and `replays_legacy_logs` before changing event schemas.
- [ ] Add table cases for missing, later-sequence, cross-run, duplicate, wrong-kind, and wrong-route cause references.
- [ ] Snapshot a representative legacy P0/P1 event sequence in the test; require unchanged final replay state.
- [ ] Confirm RED because new events/routes are unknown.
- [ ] Add strict variants for `quality.started`, `gate.started`, `gate.completed`, `requirement.evaluated`, `quality.completed`, `repair.decided`, and `run.routed` without changing old variants.
- [ ] Add only the quality routes `VERIFY -> ACCEPT`, `VERIFY -> FIX`, `ACCEPT -> DOCUMENT`, and `ACCEPT -> REWORK`.
- [ ] Validate route causation against earlier same-run history in `validateEventHistory`; do not hide this rule in console checks.
- [ ] Ensure reducer replay is deterministic when quality events are interleaved with existing step events.
- [ ] Run focused tests, existing event/controller/recovery tests, then standard v4 commands.

Expected: legacy logs replay unchanged; a route with invalid causation is rejected before it can mutate durable state.

Suggested checkpoint: `feat(v4): add causal quality event protocol`

## Task 4: Gate Runner and Trusted Evidence

**Requirements:** R12-R18
**Skills:** `@skill:test-driven-development`, `@skill:systematic-debugging`

**Files:**

- Create: `src/v4/quality/gate-runner.ts`
- Create: `test/v4/gate-runner.test.ts`
- Reuse: `src/v4/process/types.ts`
- Reuse: `src/v4/process/node-process-runner.ts`

- [ ] Write `argv_only_execution`, `records_command_evidence`, `bounds_output_summaries`, `records_output_digests`, `redacts_environment`, `termination_taxonomy`, and `passed_requires_zero_exit_and_evidence`.
- [ ] Use a fake `ProcessRunner`; assert the exact `ProcessRequest`, including `shell: false`, cwd, timeout, and abort signal.
- [ ] Cover exited 0, exited nonzero, timed-out, aborted, output-limit, spawn-error, and signalled results without wall-clock sleeps.
- [ ] Prove SHA-256 is computed over full raw stdout/stderr before byte-bounded summaries are created.
- [ ] Confirm RED.
- [ ] Implement `GateRunner.run(definition, context): Promise<{result; evidence}>` with injected clock, ID factory, runner, and event append boundary.
- [ ] Persist `gate.started` before invoking the process; validate and persist evidence before `gate.completed`.
- [ ] Map nonzero exit to `failed`; map unavailable trustworthy answers to `inconclusive`; never map timeout/abort/spawn/signalled/output-limit to pass.
- [ ] If evidence validation or persistence fails, return/record inconclusive where durable history permits and propagate the persistence boundary so the caller blocks.
- [ ] Ensure evidence serializes no environment object or values.
- [ ] Run focused and standard v4 commands.

Expected: `passed` is possible only for exit code 0 plus valid persisted evidence; every other termination remains distinguishable.

Suggested checkpoint: `feat(v4): execute quality gates with trusted evidence`

## Task 5: Deterministic Acceptance Engine

**Requirements:** R3, R8, R19-R20
**Skills:** `@skill:test-driven-development`

**Files:**

- Create: `src/v4/quality/acceptance-engine.ts`
- Create: `test/v4/acceptance-engine.test.ts`

- [ ] Add `mandatory_non_pass_fails_closed`, `unmapped_hard_test_inconclusive`, `same_run_evidence_correlation`, and `accepted_requirement_has_evidence`.
- [ ] Add negative matrices for wrong run, wrong cycle, missing ID, duplicate evidence, skipped mandatory gate, inconclusive mandatory gate, and optional skipped gate.
- [ ] Confirm RED.
- [ ] Implement a pure `AcceptanceEngine.evaluate(input)` with no filesystem, process, adapter, or clock access.
- [ ] Evaluate hard-test mappings before agent strategies. Require every mandatory mapped gate to pass and at least one valid same-run evidence reference.
- [ ] Return stable ordered verdicts in requirements declaration order.
- [ ] Make unmapped hard tests inconclusive with an actionable rationale; never fall back to agent judgement.
- [ ] Run focused and standard v4 commands.

Expected: no accepted mandatory hard-test requirement lacks valid same-run evidence.

Suggested checkpoint: `feat(v4): evaluate deterministic acceptance fail closed`

## Task 6: Restricted Agent Judgement

**Requirements:** R21-R25
**Skills:** `@skill:test-driven-development`, `@skill:api-and-interface-design`

**Files:**

- Create: `src/v4/quality/agent-judge.ts`
- Create: `test/v4/agent-judge.test.ts`
- Reuse: `src/v4/contracts/adapter.ts`
- Reuse: `src/v4/adapters/registry.ts`

- [ ] Write `agent_strategy_only`, `read_only_no_elevation`, `cannot_forge_hard_evidence`, `unavailable_is_inconclusive`, and `malformed_is_inconclusive`.
- [ ] Add correlation tests for wrong requirement ID, unknown evidence ID, and malformed structured output.
- [ ] Confirm RED.
- [ ] Define a strict structured judgement schema containing only requirement ID, accepted/rejected/inconclusive status, rationale, and existing evidence IDs.
- [ ] Implement invocation only when `testStrategy.kind === "agent"`; request read-only side effects, no elevation, and structured output.
- [ ] Validate cited IDs against existing same-run evidence. Do not accept command output, artifact claims, or new deterministic evidence from the judge.
- [ ] Normalize absent/incompatible adapters to `AGENT_JUDGE_UNAVAILABLE`; malformed/correlation failures to `AGENT_JUDGE_MALFORMED`; both produce inconclusive verdicts.
- [ ] Run focused adapter-contract tests and standard v4 commands.

Expected: agent judgement cannot authorize any hard-test requirement or forge deterministic evidence.

Suggested checkpoint: `feat(v4): constrain agent judgement to explicit requirements`

## Task 7: Bounded Repair Policy

**Requirements:** R39-R42
**Skills:** `@skill:test-driven-development`

**Files:**

- Create: `src/v4/quality/repair-policy.ts`
- Create: `test/v4/repair-policy.test.ts`

- [ ] Write `counts_per_requirement`, `default_max_two`, `no_progress_stops`, and `repair_invalidates_verdicts`.
- [ ] Include multi-requirement cases proving one exhausted requirement does not corrupt another counter.
- [ ] Confirm RED.
- [ ] Canonicalize and SHA-256 hash failure signature, sorted failed IDs, and sorted evidence digests.
- [ ] Return a typed repair decision only when every targeted requirement is under budget and the fingerprint changed.
- [ ] Return stable `REPAIR_NO_PROGRESS` immediately for unchanged input and `REPAIR_BUDGET_EXHAUSTED` at the configured cap.
- [ ] Invalidate only verdicts affected by the repair and require fresh cycle evidence before reacceptance.
- [ ] Run focused and standard v4 commands.

Expected: default repair attempts never exceed two per requirement and no-progress stops before another repair step.

Suggested checkpoint: `feat(v4): add bounded progress-aware repair policy`

## Task 8: Atomic Evidence Bundle Store

**Requirements:** R43-R45
**Skills:** `@skill:test-driven-development`, `@skill:systematic-debugging`

**Files:**

- Create: `src/v4/quality/evidence-bundle-store.ts`
- Create: `test/v4/evidence-bundle.test.ts`
- Reuse: `src/v4/storage/paths.ts`

- [ ] Write `complete_bundle`, `atomic_checksum_record`, and `corrupt_bundle_fails_closed`.
- [ ] Add fault cases before temp write, after temp write, before rename, after bundle rename, and during record write.
- [ ] Confirm RED.
- [ ] Define strict schemas for `bundle.json` and `bundle.record.json`; include all fields named in R43.
- [ ] Canonicalize ordering, serialize bytes once, hash those exact bytes, and record hash plus byte size.
- [ ] Write to a sibling temporary file, fsync file, rename atomically, and sync directory where supported; clean only owned temp files.
- [ ] On read, validate schema, run/cycle identity, byte size, checksum, and every evidence/verdict reference before returning trusted data.
- [ ] Convert missing/corrupt/mismatched bundle into a blocking quality result; never silently regenerate acceptance evidence.
- [ ] Run focused and standard v4 commands.

Expected: only a fully valid checksum-backed bundle can be used for acceptance or route authorization.

Suggested checkpoint: `feat(v4): persist atomic quality evidence bundles`

## Task 9: Coordinator and Run Orchestrator

**Requirements:** R1, R26-R30
**Skills:** `@skill:test-driven-development`, `@skill:api-and-interface-design`

**Files:**

- Create: `src/v4/quality/quality-coordinator.ts`
- Create: `src/v4/orchestration/run-orchestrator.ts`
- Create: `test/v4/orchestrator.test.ts`
- Modify: `src/v4/index.ts`

- [ ] Write `quality_boundary`, `verify_to_accept`, `verify_to_fix`, `accept_to_document`, `accept_to_rework`, and `mandatory_inconclusive_blocks`.
- [ ] In `quality_boundary`, fake the coordinator and prove `RunController` never receives config, Markdown, runner, or gate commands.
- [ ] Add persistence-failure and invalid-decision cases; neither may advance state.
- [ ] Confirm RED.
- [ ] Implement `QualityCoordinator.verify` and `.accept` as composition roots for loaders, sequential runner, acceptance engine, judge, repair policy, and bundle store.
- [ ] Implement `RunOrchestrator` to append decision events, verify their durability, then append one exact `run.routed` event with the causal event ID.
- [ ] Route only the four approved pairs. Turn mandatory inconclusive conditions into `block` with concrete `requiredAction`.
- [ ] Keep one agent step in flight; do not add P3 concurrency here.
- [ ] Export new public composition interfaces from `src/v4/index.ts`.
- [ ] Run focused, controller, replay, and standard v4 commands.

Expected: the controller remains unchanged in responsibility; every quality route is exact, causal, durable, and fail-closed.

Suggested checkpoint: `feat(v4): orchestrate quality decisions and routes`

## Task 10: Quality Recovery and Fault Injection

**Requirements:** R34-R38, R46
**Skills:** `@skill:test-driven-development`, `@skill:systematic-debugging`

**Files:**

- Modify: `src/v4/core/recovery.ts`
- Create: `test/v4/quality-recovery.test.ts`
- Create: `test/v4/quality-fault-injection.test.ts`
- Modify: `src/v4/testing/fault-scenarios.ts`

- [ ] Write `interrupted_cycle_not_passed`, `resume_new_cycle`, `reruns_read_only_gate`, `workspace_write_retry_policy`, `ambiguous_recovery_blocks`, and `zero_false_green`.
- [ ] Generate crash cuts after every new quality event type and around bundle persistence boundaries.
- [ ] Assert repeated resume is idempotent: no duplicate route, no duplicate repair count, and no reuse of interrupted pass evidence.
- [ ] Confirm RED.
- [ ] Extend recovery analysis to identify incomplete cycles by durable events and bundle state.
- [ ] Preserve incomplete history but start a fresh cycle/operation ID on resume.
- [ ] Permit read-only rerun; permit workspace-write rerun only with `retrySafe`; otherwise block with `QUALITY_RECOVERY_UNSAFE` and required action.
- [ ] Make the fault oracle count any run reaching `ACCEPT`, `DOCUMENT`, or `READY` without valid mandatory evidence as false green.
- [ ] Run both focused files at least three times, then standard v4 commands.

Expected: all crash points produce zero false greens and repeated recovery converges to one safe state.

Suggested checkpoint: `test(v4): harden quality recovery against false green`

## Task 11: P2 Integration, Documentation, and Exit Gate

**Requirements:** R1-R46
**Skills:** `@skill:documentation-and-adrs`, `@skill:requesting-code-review`, `@skill:verification-before-completion`

**Files:**

- Modify if implementation differs: `docs/v4/adr/0005-quality-routing-and-evidence.md`
- Modify: `plans/v4/2026-08-20-p2-reliability-spec.md` status only after all checks pass
- Verify: `.omni/sdlc/requirements.md`

- [ ] Build a traceability table mapping every R1-R46 to its named test and confirm no requirement is covered only by prose.
- [ ] Review public exports for accidental vendor coupling, shell strings, environment persistence, or `RunController` responsibility creep.
- [ ] Review new errors/events for stable schemas and legacy replay compatibility.
- [ ] Run the full exit commands exactly as listed below and save the actual counts in the handoff.

```powershell
npm run typecheck:v4
npm run build:v4
npm run test:v4
npm test
git diff --check
git status --short
```

- [ ] Run focused safety checks:

```powershell
npx tsx --test test/v4/quality-contracts.test.ts test/v4/requirements.test.ts test/v4/quality-config.test.ts
npx tsx --test test/v4/gate-runner.test.ts test/v4/acceptance-engine.test.ts test/v4/agent-judge.test.ts
npx tsx --test test/v4/quality-replay.test.ts test/v4/repair-policy.test.ts test/v4/evidence-bundle.test.ts
npx tsx --test test/v4/orchestrator.test.ts test/v4/quality-recovery.test.ts test/v4/quality-fault-injection.test.ts
```

- [ ] Mark the P2 spec `Implemented` only if all R1-R46 pass and the full regression is green.
- [ ] Produce a handoff containing changed files, interface deltas, exact commands/results, skips with reasons, remaining risks, and rollback scope.
- [ ] Do not commit. Report suggested final checkpoint: `feat(v4): complete P2 reliability and acceptance`.

## P2 Stop Conditions

Stop and report `BLOCKED` instead of improvising when:

- an approved public interface must change materially;
- an existing P0/P1 event cannot remain replayable;
- a persistence failure could be mistaken for acceptance;
- recovery cannot distinguish whether a workspace-write gate completed;
- a hard-test requirement would require executing raw Markdown;
- full regression fails outside the intended P2 surface and root cause is not established.

## P2 Handoff Template

```text
Status: COMPLETE | BLOCKED
Requirements: R1-R46 passed/failed count
Changed files: exact paths
Public interfaces: added/changed exports
Verification: exact command -> actual result
Skips: exact test and reason
Safety evidence: false-green count; replay result; recovery result
Known risks: bounded list
Rollback: files/modules to revert; persisted format implications
Suggested checkpoint only: <message>
Commit/push performed: no
```

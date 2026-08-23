# Omni v4 P2/P3 Acceptance Remediation Implementation Plan

> **Executor:** Gemini 3.7 Flash High via Antigravity (`agy`). Execute one phase at a time with review checkpoints.

**Goal:** Close the confirmed correctness, durability, recovery, concurrency, metrics, dogfood, and traceability gaps in the current uncommitted P2/P3 implementation so R1-R79 are demonstrably satisfied without regressing P0/P1.

**Architecture:** Keep `RunController` deterministic and free of command execution. `QualityCoordinator` owns orchestration, but acceptance is authorized only from correlated, validated, durable evidence. Route events must be causally linked to a persisted quality/repair decision. Recovery, repair, and benchmark behavior remain bounded and fail closed.

**Tech Stack:** TypeScript, Node.js, Zod, `node:test`, append-only event store, SHA-256 records, PowerShell-compatible npm scripts.

---

## Execution contract

- Work on the current `v4` checkout and preserve all existing uncommitted files.
- Do not commit, push, reset, delete unrelated output, or rewrite P0/P1 architecture.
- Use TDD for every behavior change: add the exact requirement-named failing test, run it and confirm the intended failure, implement the smallest coherent change, rerun focused tests.
- Exact test names from `.omni/sdlc/requirements.md` are part of acceptance. Equivalent coverage with a different name is not sufficient.
- Keep public changes additive where possible. If a contract must change, update all callers and tests in the same phase.
- Never run live/model-cost benchmarks. Deterministic tests use fake adapters only.
- Never fabricate process evidence for skipped, dependency-blocked, unavailable, or inconclusive gates.
- Do not update traceability matrices or verification reports to PASS until all cited commands have been rerun successfully.
- Stop the current phase and report `BLOCKED` if satisfying it requires an incompatible P0/P1 event-schema change, a destructive operation, real credentials, live model quota, or an undocumented public-API break.

## Baseline evidence

The pre-remediation checkout currently reports:

- `npm run typecheck:v4`: PASS
- `npm run build:v4`: PASS
- `npm run test:v4`: 158 passed, 2 expected skipped, 0 failed
- `npm run benchmark:v4`: 12 passed, 3 disabled skipped, 0 failed
- `npm test`: P0/P1 and current P2/P3 tests pass
- `npm audit --audit-level=high`: 0 vulnerabilities

These are regression baselines, not acceptance proof. Only 33 of 79 exact requirement test names were present at audit time, and several current tests assert weaker behavior than the approved requirements.

## Phase 0: Build an honest traceability guard

**Files:**

- Create: `test/v4/requirements-traceability.test.ts`
- Modify later, after all phases pass: `plans/v4/2026-08-20-p2-traceability-matrix.md`
- Modify later, after all phases pass: `plans/v4/2026-08-20-p3-traceability-matrix.md`
- Modify later, after all phases pass: `plans/v4/2026-08-20-p2-verification-report.md`
- Modify later, after all phases pass: `plans/v4/2026-08-20-p3-verification-report.md`

### Task 0.1: Add exact-name coverage validation

1. Parse `.omni/sdlc/requirements.md` and collect every `test:` target for R1-R78. Treat R79 (`npm test`) as a command-level requirement.
2. Scan the referenced test file for an exact `test(...)` or `it(...)` name equal to the suffix after `::`.
3. Fail with the missing requirement ID, file, and exact test name. Do not infer coverage from substrings or aliases.
4. Add a self-test fixture proving a renamed-but-similar test does not count.
5. Do not mark Phase 0 green until later phases have created every exact name; during remediation this test is expected to expose the remaining list.

**Checkpoint command:**

```powershell
node --test --import tsx test/v4/requirements-traceability.test.ts
```

**Expected before final phase:** FAIL with an accurate, monotonically shrinking missing-test list.

---

## Phase 1: Trusted evidence, deterministic acceptance, and agent judgement

**Files:**

- Modify: `src/v4/contracts/quality.ts`
- Modify: `src/v4/quality/gate-runner.ts`
- Modify: `src/v4/quality/acceptance-engine.ts`
- Modify: `src/v4/quality/agent-judge.ts`
- Modify: `src/v4/quality/quality-coordinator.ts`
- Modify: `test/v4/gate-runner.test.ts`
- Modify: `test/v4/acceptance-engine.test.ts`
- Modify: `test/v4/agent-judge.test.ts`

### Task 1.1: Define evidence validation and correlation contracts

1. Add or tighten schemas so a process evidence item contains run ID, cycle ID, gate ID, operation ID, exact argv, cwd, timeout, termination taxonomy, exit code, start time, duration, bounded summaries, and full-output SHA-256 digests.
2. Define a reusable validation/correlation function rather than duplicating ad-hoc checks.
3. A valid passed deterministic gate must have one real process evidence item with matching run/cycle/gate/operation IDs, termination `exited`, and exit code `0`.
4. Evidence IDs must be unique within a cycle. Missing, duplicate, cross-run, cross-cycle, cross-gate, or cross-operation evidence fails closed.
5. Preserve the four gate states. Validation failure cannot be converted to `passed`.

**Required exact tests:**

- `test/v4/gate-runner.test.ts::passed_requires_zero_exit_and_evidence`
- `test/v4/acceptance-engine.test.ts::same_run_evidence_correlation`
- `test/v4/acceptance-engine.test.ts::accepted_requirement_has_evidence`

### Task 1.2: Make output summaries byte-bounded and execution contained

1. Enforce configured repository-root containment immediately before spawn, not only when loading config. Resolve paths sufficiently to reject symlink/realpath escape where supported.
2. Continue using `command` plus `args[]` and `shell: false`.
3. Bound stdout/stderr summaries by UTF-8 bytes without splitting a multi-byte code point; retain digests of complete streams.
4. Reject an internally invalid evidence object before returning a passed gate result.

**Required exact tests:** retain R12-R18 names, including byte-heavy Unicode cases and a path/symlink escape case under the closest exact requirement test.

### Task 1.3: Evaluate requirements from real evidence

1. Change `AcceptanceEngine` input to receive gate results and the evidence collection/index needed for correlation.
2. A mandatory `hard` requirement accepts only when every configured mapped gate passed and each pass is backed by correlated valid evidence.
3. `skipped` and `inconclusive` never satisfy a mandatory gate.
4. A hard requirement with no configured mapping is `inconclusive`.
5. Every accepted mandatory verdict contains at least one validated same-run evidence ID; never synthesize IDs.

**Required exact tests:**

- `mandatory_non_pass_fails_closed`
- `unmapped_hard_test_inconclusive`
- `same_run_evidence_correlation`
- `accepted_requirement_has_evidence`

### Task 1.4: Constrain agent judgement

1. Invoke judgement only when `testStrategy === "agent"` exactly.
2. The adapter request must be read-only, disallow elevation, and include requirement identity plus available existing evidence metadata.
3. Require strict structured JSON containing the same requirement ID, status/rationale, and cited existing evidence IDs. Reject code fences, extra prose, unknown IDs, cross-run evidence, and malformed output.
4. Agent judgement may cite existing evidence but cannot manufacture deterministic process evidence or override a hard gate.
5. Missing/unavailable adapter produces an explicit `inconclusive` result with a stable actionable reason. Malformed output produces `AGENT_JUDGE_MALFORMED` and `inconclusive`.

**Required exact tests:**

- `agent_strategy_only`
- `read_only_no_elevation`
- `cannot_forge_hard_evidence`
- `unavailable_is_inconclusive`
- `malformed_is_inconclusive`

### Phase 1 checkpoint

```powershell
node --test --import tsx test/v4/gate-runner.test.ts test/v4/acceptance-engine.test.ts test/v4/agent-judge.test.ts
npm run typecheck:v4
```

**Acceptance:** all exact tests above pass; no synthetic evidence exists for non-executed gates; no `as any` is used to bypass the quality contract.

---

## Phase 2: Durable bundle and route-after-durability sequencing

**Files:**

- Modify: `src/v4/quality/evidence-bundle-store.ts`
- Modify: `src/v4/quality/quality-coordinator.ts`
- Modify: `src/v4/contracts/event.ts`
- Modify if required: `src/v4/core/reducer.ts`
- Modify: `test/v4/evidence-bundle.test.ts`
- Modify: `test/v4/orchestrator.test.ts`
- Modify: `test/v4/quality-fault-injection.test.ts`

### Task 2.1: Complete the evidence bundle

1. Bundle schema must include version, run identity, cycle identity, `configHash`, `requirementsHash`, gate results in declaration order, evidence, requirement verdicts, repair history, and decision/route intent.
2. Hash canonical input bytes. State and test the canonicalization rule; do not hash mutable display output.
3. Validate all internal references and correlations on write and read.
4. Use approved layout: `.omni/v4/runs/<runId>/quality/bundle.json` and sibling `bundle.record.json`. If multiple cycles are retained, place immutable cycle artifacts below the run and make the authorized bundle/record point unambiguously to the accepted/latest cycle.

**Required exact test:** `complete_bundle`.

### Task 2.2: Atomic checksum-backed persistence

1. Write bundle bytes to an owned temporary file in the destination directory.
2. Flush the file, atomically rename, flush the directory where supported, then write a checksum record using the same atomic protocol.
3. Record SHA-256, byte length, bundle version, run ID, and cycle ID.
4. `readBundle` validates record schema, byte length, digest, bundle schema, and correlation before returning data.
5. Missing/corrupt/checksum-mismatched data must never authorize acceptance.

**Required exact tests:**

- `atomic_checksum_record`
- `corrupt_bundle_fails_closed`

### Task 2.3: Persist before route

1. Remove fabricated skipped/inconclusive evidence in `QualityCoordinator`.
2. Construct and validate the complete bundle after gate/judgement/repair decision events exist.
3. Persist and re-read/verify the bundle before emitting a route that advances to `ACCEPT` or `DOCUMENT`.
4. On persistence or verification failure, emit/return a stable blocking outcome; do not append an advancing `run.routed` event.
5. Every route cites a prior same-run durable quality or repair decision event.

**Required exact tests:**

- `verify_to_accept`
- `verify_to_fix`
- `accept_to_document`
- `accept_to_rework`
- `mandatory_inconclusive_blocks`
- a fault test proving bundle write/rename/record/checksum failure yields zero false-green routes

### Phase 2 checkpoint

```powershell
node --test --import tsx test/v4/evidence-bundle.test.ts test/v4/orchestrator.test.ts test/v4/quality-fault-injection.test.ts test/v4/quality-replay.test.ts
npm run typecheck:v4
```

---

## Phase 3: Requirement-scoped repair and safe recovery

**Files:**

- Modify: `src/v4/quality/repair-policy.ts`
- Modify: `src/v4/quality/quality-coordinator.ts`
- Modify: `src/v4/core/recovery.ts`
- Modify: `src/v4/contracts/event.ts`
- Modify: `src/v4/core/reducer.ts`
- Modify: `test/v4/repair-policy.test.ts`
- Modify: `test/v4/quality-recovery.test.ts`
- Modify: `test/v4/quality-replay.test.ts`

### Task 3.1: Make repair history requirement-scoped and deterministic

1. Count attempts per affected requirement, with default maximum two per requirement.
2. Persist ordered repair history containing affected requirement IDs, prior verdict IDs/evidence IDs, attempt counters, and outcome.
3. Compute a SHA-256 no-progress fingerprint over a canonical tuple of failure signature, sorted failed requirement IDs, and sorted evidence digests.
4. An unchanged fingerprint stops immediately with `REPAIR_NO_PROGRESS`.
5. A repair invalidates prior verdicts for affected requirements. They can be accepted again only from a fresh cycle with fresh correlated evidence.

**Required exact tests:**

- `counts_per_requirement`
- `default_max_two`
- `no_progress_stops`
- `repair_invalidates_verdicts`

### Task 3.2: Recover interrupted quality cycles safely

1. Preserve an interrupted cycle and its partial events as audit evidence; never reinterpret it as passed.
2. Resume with a fresh cycle ID and fresh operation IDs for every rerun.
3. Read-only gates may rerun. Workspace-write gates rerun only when their definition has `retrySafe: true`.
4. A missing gate definition, ambiguous operation/cycle correlation, unsafe workspace-write retry, or corrupt authorized bundle blocks with `QUALITY_RECOVERY_UNSAFE` and an actionable required action.
5. Roll forward from `quality.completed` only if the referenced bundle and checksum record validate and its route intent/cause is unambiguous.

**Required exact tests:**

- `interrupted_cycle_not_passed`
- `resume_new_cycle`
- `reruns_read_only_gate`
- `workspace_write_retry_policy`
- `ambiguous_recovery_blocks`

### Phase 3 checkpoint

```powershell
node --test --import tsx test/v4/repair-policy.test.ts test/v4/quality-recovery.test.ts test/v4/quality-replay.test.ts
npm run typecheck:v4
```

---

## Phase 4: Bounded gate scheduling and deterministic equivalence

**Files:**

- Modify: `src/v4/quality/gate-scheduler.ts`
- Modify: `src/v4/orchestration/run-orchestrator.ts`
- Modify: `test/v4/gate-scheduler.test.ts`
- Modify: `test/v4/orchestrator.test.ts`
- Modify: `test/v4/report.test.ts`

### Task 4.1: Harden scheduler completion and failure normalization

1. Keep agent steps globally single in-flight. Only eligible quality gates run concurrently.
2. Before starting a gate, require all dependencies to have passed and all concurrency/workspace locks to be available.
3. On a gate failure, do not start dependent gates. Let already-running independent gates settle and retain their real results/evidence.
4. Normalize runner promise rejection to an explicit non-pass gate result; avoid unhandled rejections.
5. Detect impossible scheduler/deadlock states and fail with an explicit error rather than returning an incomplete map.
6. Preserve declaration order in returned results and reports regardless of completion order.

**Required exact tests:**

- `agent_steps_remain_serial`
- `dependency_order`
- `active_gates_finish`
- `parallel_sequential_equivalence`
- `stable_gate_order`

### Task 4.2: Prove equivalence

1. Run the same fixture with `maxParallelGates: 1` and a value greater than one.
2. Normalize timing-only fields.
3. Assert identical requirement verdicts, evidence-to-gate mapping, decision, and stable report order.

### Phase 4 checkpoint

```powershell
node --test --import tsx test/v4/gate-scheduler.test.ts test/v4/orchestrator.test.ts test/v4/report.test.ts
npm run typecheck:v4
```

---

## Phase 5: Honest metrics and budgets

**Files:**

- Modify: `src/v4/metrics/contracts.ts`
- Modify: `src/v4/metrics/collector.ts`
- Modify: `src/v4/metrics/budget-policy.ts`
- Modify: `test/v4/metrics.test.ts`
- Modify: `test/v4/budget-policy.test.ts`

### Task 5.1: Derive metrics from durable inputs

1. Derive actual status from validated persisted outcomes, never default to success when bundle/evidence is absent.
2. Keep actual status, reported status, false-success, and false-failure independently visible.
3. Measure the documented quality window for wall clock; derive summed duration, queue time, peak parallelism, and speedup consistently. No schedules means peak parallelism zero, not one.
4. Extract available native adapter/CLI/model/session and token/cost usage metadata. Keep unavailable fields explicitly unavailable/omitted and list them in `missingMetrics`; never coerce missing usage to zero.

**Required exact test:** `native_usage_metadata`, while retaining R60-R64 names.

### Task 5.2: Preserve budget semantics

1. Default all efficiency budgets to report-only.
2. Report-only breach cannot change acceptance.
3. Mandatory breach produces failed `BUDGET_EXCEEDED`.
4. A missing mandatory metric produces `inconclusive`, not pass or zero.

### Phase 5 checkpoint

```powershell
node --test --import tsx test/v4/metrics.test.ts test/v4/budget-policy.test.ts
npm run typecheck:v4
```

---

## Phase 6: Real deterministic dogfood and reproducible benchmark reports

**Files:**

- Modify: `src/v4/benchmark/contracts.ts`
- Modify: `src/v4/benchmark/manifest.ts`
- Modify: `src/v4/benchmark/runner.ts`
- Modify: `src/v4/benchmark/report.ts`
- Modify: `src/v4/benchmark/cli.ts`
- Modify: `benchmarks/v4/manifest.json`
- Modify: benchmark fixtures as required
- Modify: `test/v4/benchmark-manifest.test.ts`
- Modify: `test/v4/benchmark-runner.test.ts`
- Modify: `test/v4/benchmark-e2e.test.ts`
- Modify: `test/v4/report.test.ts`

### Task 6.1: Isolate and constrain benchmark cases

1. Create each enabled case in an owned temporary workspace and verify every resolved source/destination remains contained; reject symlink escape.
2. Deterministic cases use a fake adapter by default and consume no model quota.
3. Live execution requires three-part opt-in: manifest `liveModelCostOptIn=true`, environment variable `OMNI_V4_ALLOW_MODEL_COST=1`, and runner option `allowModelCost=true`. If any condition is missing, zero adapter factory, execute, or process calls occur.
4. Support declared repository paths for disabled/future slots without silently treating them as self-dogfood.

**Required exact tests:**

- `isolated_workspace`
- `fake_adapter_default`
- `live_host_requires_opt_in`

### Task 6.2: Make the self-dogfood case real

1. The enabled Omni case must stage the actual repository inputs needed to run the real v4 build/typecheck/test path in isolation. A generated `node -e process.exit(0)` package is forbidden.
2. Keep execution deterministic and offline; reuse installed dependencies safely or document/stage the exact mechanism.
3. Assert the case exercised real Omni scripts and that an injected correctness regression makes the P3 gate fail even if performance improves.
4. Evaluate all manifest expectations: status, false success/failure, repair count, recovery outcome, concurrency, and budget breach.

**Required exact tests:** `correctness_precedes_efficiency` plus the manifest R73-R75 tests.

### Task 6.3: Persist reproducible reports

1. Write under `.omni/v4/benchmarks/<benchmarkRunId>/report.json` and `summary.md`.
2. JSON includes schema version, manifest/config hashes, environment, live-approval state, ordered case outcomes, recovery outcomes, correctness and efficiency metrics.
3. Markdown is derived only from persisted normalized JSON inputs.
4. Define a semantic/reproducible representation that excludes or normalizes volatile timestamps, temp paths, and raw durations; the same persisted inputs must reproduce byte-identical output. Cross-run source reproducibility requires a clean Git revision; dirty or unavailable Git metadata explicitly marks source reproducibility as `NOT CLAIMABLE`.

**Required exact tests:**

- `json_and_markdown_outputs`
- `reproducible_from_inputs`

### Phase 6 checkpoint

```powershell
node --test --import tsx test/v4/benchmark-manifest.test.ts test/v4/benchmark-runner.test.ts test/v4/benchmark-e2e.test.ts test/v4/report.test.ts
npm run benchmark:v4
npm run typecheck:v4
```

**Acceptance:** 10-15 deterministic representative cases, required future slots disabled, real enabled self-dogfood, zero model calls, correctness always precedes efficiency.

---

## Phase 7: R1-R79 closure and truthful handoff

**Files:**

- Modify: all four P2/P3 traceability/verification documents listed in Phase 0
- Modify only if evidence requires: `.omni/sdlc/requirements.md` checkboxes (do not alter approved wording or test targets)

### Task 7.1: Close exact traceability

1. Run the Phase 0 exact-name validator. It must report all R1-R78 active exact file test targets present and R79 command test verified. `test.skip` and `todo` are not counted as evidence.
2. Execute every referenced test file. Do not mark a requirement met solely because its test name exists.
3. Update matrices one row per requirement with exact file/test, implementation symbols, command, and observed result.
4. Remove prior unsupported `100%` claims. State any skipped tests truthfully: the v4 unit test suite has 2 environment/cost-scoped skips not mapping mandatory targets (`test/v4/host-smoke.test.ts` when live host/cost prerequisites are absent and `test/v4/process-runner.test.ts` for POSIX signal behavior on Windows), and the benchmark has 3 disabled future slots; do not claim all skips are only benchmark slots.

### Task 7.2: Full verification

Run, in order:

```powershell
npm audit --audit-level=high
npm run typecheck:v4
npm run build:v4
npm run test:v4
npm run benchmark:v4
npm test
git diff --check
git status --short
```

### Task 7.3: Final acceptance audit

Before claiming completion, independently confirm:

- R1-R79 map to real evidence and no requirement was renumbered/reworded.
- Mandatory skipped/inconclusive outcomes cannot accept.
- Acceptance cannot occur from absent, synthetic, cross-run, stale, or corrupt evidence.
- Bundle failure cannot leave an advancing route.
- Repair is capped per requirement and no-progress stops immediately.
- Recovery uses fresh IDs and honors side-effect/retry safety.
- Only quality gates parallelize; active gates settle; report order is stable.
- Missing usage is not zero and missing outcome is not success.
- Live benchmark adapter is unreachable without all three required opt-in conditions.
- Self-dogfood executes real Omni validation.
- P0/P1 remain green.

## Gemini handoff protocol

For each phase, Gemini must return:

1. exact files changed;
2. exact tests first observed failing and why;
3. implementation summary tied to requirement IDs;
4. focused commands and raw pass/fail counts;
5. assumptions, remaining gaps, and any `BLOCKED` item;
6. confirmation that it did not commit, push, invoke a live adapter, or delete unrelated files.

The reviewer must inspect the diff and rerun focused checks. If rejected, send Gemini the concrete failing command/output and invariant violation in the same conversation. Limit blind retries: after three failed fixes for the same root cause, stop and report the blocker instead of broadening scope.

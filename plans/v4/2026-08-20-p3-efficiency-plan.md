# Omni v4 P3 Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded quality-gate concurrency, trustworthy metrics, optional budgets, deterministic benchmarks, and reproducible Omni self-dogfood satisfying `.omni/sdlc/requirements.md` R47-R79 without weakening P0-P2 correctness.

**Architecture:** Extend the P2 quality subsystem with a DAG-aware `GateScheduler` that invokes the unchanged `GateRunner`. Keep agent steps serial and all run-state transitions single in-flight. Derive metrics only from durable events, trusted evidence, and native adapter metadata. Run benchmarks in isolated temporary workspaces and generate Markdown only from a versioned JSON report.

**Tech Stack:** Node.js 20+, TypeScript strict mode, Zod 4, `node:test`, controlled promises for concurrency tests, injected monotonic/wall clocks, SHA-256, temporary directories, existing P0-P2 orchestrator and fake adapter.

## Entry Gate

P3 starts only after P2 is implemented and these commands pass:

```powershell
npm run typecheck:v4
npm run test:v4
npm test
```

If any P2 test named in `plans/v4/2026-08-20-p2-reliability-plan.md` is absent or failing, stop. Do not build a scheduler or benchmark around incomplete quality semantics.

## Global Constraints

- Normative contract: `plans/v4/2026-08-20-p3-efficiency-spec.md` and R47-R79 in `.omni/sdlc/requirements.md`.
- Work task-by-task in order. Write each named test first, confirm RED for the intended missing behavior, implement minimally, then confirm GREEN.
- Use `@skill:test-driven-development` for implementation, `@skill:systematic-debugging` for unexpected failures, and `@skill:verification-before-completion` before completion claims.
- Parallelize only independent quality gates. Never run two agent adapter steps or two state transitions concurrently.
- Default `maxParallelGates` to 2 and accept only integers 1..8.
- Preserve P2 gate status, evidence, acceptance, repair, event, bundle, and recovery semantics exactly.
- Do not use timing sleeps in concurrency unit tests; use deferred/controlled promises and explicit start/settle barriers.
- Do not coerce missing token, cost, adapter, model, CLI, or session metadata to zero or empty strings.
- Budget mode defaults to `report`; only explicit `mandatory` limits may block.
- Never let speed, token, or cost improvement compensate for a correctness failure.
- Deterministic benchmarks use `FakeAdapter` and no model quota. Live adapters require three-part opt-in: manifest `liveModelCostOptIn=true`, environment variable `OMNI_V4_ALLOW_MODEL_COST=1`, and runner option `allowModelCost=true`; if any condition is missing, zero adapter factory/execute/process calls occur.
- Never run an enabled repository case in the user's source checkout; always copy into an owned temporary workspace. Cross-run source reproducibility requires a clean Git revision (`isDirty=false`); dirty/unavailable metadata marks source reproducibility as `NOT CLAIMABLE`.
- Do not commit, push, tag, publish, deploy, or invoke a live host without explicit permission in the active session.
- Do not overwrite `.omni/sdlc/todo.md`.

## Standard Commands

After every task:

```powershell
npm run typecheck:v4
npm run test:v4
```

At the final gate:

```powershell
npm run build:v4
npm test
git diff --check
```

## Locked File Map

Create:

```text
src/v4/quality/gate-scheduler.ts
src/v4/metrics/contracts.ts
src/v4/metrics/collector.ts
src/v4/metrics/budget-policy.ts
src/v4/benchmark/contracts.ts
src/v4/benchmark/manifest.ts
src/v4/benchmark/runner.ts
src/v4/benchmark/report.ts
benchmarks/v4/manifest.json
benchmarks/v4/fixtures/
```

Modify only as required:

```text
src/v4/contracts/quality.ts
src/v4/quality/config.ts
src/v4/quality/quality-coordinator.ts
src/v4/orchestration/run-orchestrator.ts
src/v4/index.ts
package.json
scripts/run-v4-tests.cjs
```

Use the interfaces in P3 spec sections 4, 5, and 7 verbatim. New modules may add internal types, but must not rename or widen `GateSchedulerOptions`, `GateScheduleResult`, `RunMetrics`, `BenchmarkManifest`, or `BenchmarkCase`.

## Post-P2 Integration Anchors

Resolve these symbols after P2 completion and record their actual line numbers in the Task 1 handoff before editing:

| Responsibility | Required symbol/file | P3 rule |
|---|---|---|
| Gate semantics | `GateRunner` in `src/v4/quality/gate-runner.ts` | Invoke unchanged; scheduler never interprets process output |
| Quality composition | `QualityCoordinator` in `src/v4/quality/quality-coordinator.ts` | Replace sequential scheduling only |
| Agent/run sequencing | `RunOrchestrator` in `src/v4/orchestration/run-orchestrator.ts` | Keep one agent step and transition in flight |
| Quality config | `QualityConfigSchema` in `src/v4/quality/config.ts` | Add strict optional P3 fields with safe defaults |
| Evidence contract | `QualityEvidence` in `src/v4/contracts/quality.ts` | Do not weaken or cache across changed workspaces |
| Durable events | `RunEventSchema` in `src/v4/contracts/event.ts` | Metrics consume validated events, not prose |
| Native usage | `NormalizedUsage` in `src/v4/contracts/step-result.ts` | Preserve missing fields as unavailable |
| Fake execution | `FakeAdapter` in `src/v4/testing/fake-adapter.ts` | Default for deterministic benchmarks |

---

## Task 1: P3 Configuration, Contracts, and DAG Validation

**Requirements:** R48-R51, R65, R69
**Skills:** `@skill:api-and-interface-design`, `@skill:test-driven-development`

**Files:**

- Modify: `src/v4/contracts/quality.ts`
- Modify: `src/v4/quality/config.ts`
- Create: `src/v4/quality/gate-scheduler.ts`
- Create: `src/v4/metrics/contracts.ts`
- Create: `src/v4/benchmark/contracts.ts`
- Create: `src/v4/benchmark/manifest.ts`
- Modify: `test/v4/quality-config.test.ts`
- Create: `test/v4/gate-scheduler.test.ts`
- Create: `test/v4/benchmark-manifest.test.ts`

- [ ] Add `default_parallelism_two`, `parallelism_bounds`, `rejects_invalid_dag_references`, `rejects_cycle`, `default_report_only`, and `strict_versioned_manifest`.
- [ ] Test 0, 9, negative, fractional, string, `NaN`, and unknown config fields.
- [ ] Test duplicate gate IDs/dependencies, missing dependency, self-dependency, multi-node cycle, blank/invalid concurrency key, and prove zero runner calls.
- [ ] Test strict benchmark schemas: duplicate IDs, unknown fields, omitted expectations, path escape, and invalid adapter/project kind.
- [ ] Confirm RED.
- [ ] Extend strict quality config with `maxParallelGates` and optional budget limits; preserve every P2 default and rejection rule.
- [ ] Implement pure `validateGateDag(definitions)` before scheduler execution. Use declaration order for stable traversal and error details.
- [ ] Add P3 error codes exactly as listed in spec section 12.
- [ ] Define strict metrics and benchmark contracts. Represent unavailable optional metrics by absence plus `missingMetrics`, never sentinel zero.
- [ ] Implement manifest path containment relative to repository root; enabled external cases require a resolved repository path.
- [ ] Run focused and standard v4 commands.

Expected: all invalid graph/config/manifest inputs fail before any process or adapter starts.

Suggested checkpoint: `feat(v4): define P3 scheduler metrics and benchmark contracts`

## Task 2: Bounded Gate Scheduler

**Requirements:** R47, R52-R58
**Skills:** `@skill:test-driven-development`, `@skill:systematic-debugging`

**Files:**

- Modify: `src/v4/quality/gate-scheduler.ts`
- Modify: `src/v4/quality/quality-coordinator.ts`
- Modify: `src/v4/orchestration/run-orchestrator.ts`
- Modify: `test/v4/gate-scheduler.test.ts`

- [ ] Add `agent_steps_remain_serial`, `dependency_order`, `parallel_independent_read_only`, `concurrency_key_lock`, `workspace_write_exclusive`, `active_gates_finish`, `failed_dependency_prevents_start`, and `parallel_sequential_equivalence`.
- [ ] Implement tests using controlled promises: record active gate IDs, resolve them manually, and assert peak concurrency without sleep-based timing.
- [ ] Add cancellation cases for active and never-started gates.
- [ ] Confirm RED.
- [ ] Implement one deterministic ready queue ordered by gate declaration index and a worker capacity capped by `maxParallelGates`.
- [ ] A gate becomes eligible only after all dependencies pass. Record an explicit non-pass result for a failed/non-pass dependency; never omit it.
- [ ] Add lock arbitration: read-only gates may overlap; equal non-empty `concurrencyKey` values may not; any `workspace-write` gate owns the global exclusive lock.
- [ ] When a gate fails, allow already-running gates and independent ready gates to settle; launch no dependent gate.
- [ ] On external abort, signal active gates and synthesize explicit inconclusive/skipped results for never-started gates according to mandatory policy.
- [ ] Return `results`, exact `peakParallelism`, and accumulated queue milliseconds. Keep completion events in real completion order.
- [ ] Integrate scheduler only inside `QualityCoordinator`; prove `RunOrchestrator` still runs at most one agent step and one route transition at a time.
- [ ] Compare maxParallel=1 and maxParallel=2 on identical fixture evidence after normalizing operation IDs/timestamps; verdict and requirement-evidence mapping must match.
- [ ] Run focused tests at least five times, then standard v4 commands.

Expected: bounded concurrency is deterministic in eligibility/locking and semantically equivalent to sequential execution.

Suggested checkpoint: `feat(v4): schedule independent quality gates safely`

## Task 3: Durable Metrics Collector

**Requirements:** R60-R64
**Skills:** `@skill:test-driven-development`, `@skill:api-and-interface-design`

**Files:**

- Modify: `src/v4/metrics/contracts.ts`
- Create: `src/v4/metrics/collector.ts`
- Create: `test/v4/metrics.test.ts`
- Reuse: `src/v4/contracts/step-result.ts`
- Reuse: `src/v4/contracts/event.ts`

- [ ] Write `completion_metrics`, `reliability_counts`, `efficiency_metrics`, `native_usage_metadata`, and `missing_usage_not_zero`.
- [ ] Use injected fixed clocks and handcrafted durable histories; console output must not appear in test inputs.
- [ ] Cover wall-clock zero, incomplete quality window, unavailable usage, partially available usage, and inconsistent event ordering.
- [ ] Confirm RED.
- [ ] Implement a pure collector consuming validated events, bundle/evidence data, schedule results, and adapter native metadata.
- [ ] Derive `actualStatus` objectively from durable evidence and `reportedStatus` from the run claim; calculate false-success/false-failure from the pair.
- [ ] Count gate statuses, retry, repair, resume, and explicit user intervention from durable event types.
- [ ] Derive wall-clock, summed gate duration, queue time, peak parallelism, and speedup. Omit speedup when inputs are incomplete or denominator is zero.
- [ ] Preserve available `NormalizedUsage`, adapter identity, CLI, model, and session metadata. Put each absent requested field name in sorted unique `missingMetrics`.
- [ ] Reject contradictory/corrupt input rather than silently repair metrics.
- [ ] Run focused and standard v4 commands.

Expected: a missing usage field is absent and named missing; it is never serialized as `0`.

Suggested checkpoint: `feat(v4): derive trustworthy run efficiency metrics`

## Task 4: Report-Only and Mandatory Budget Policy

**Requirements:** R65-R68
**Skills:** `@skill:test-driven-development`

**Files:**

- Create: `src/v4/metrics/budget-policy.ts`
- Create: `test/v4/budget-policy.test.ts`
- Modify: `src/v4/quality/quality-coordinator.ts`

- [ ] Write `default_report_only`, `report_only_does_not_block`, `mandatory_budget_blocks`, and `mandatory_missing_metric_inconclusive`.
- [ ] Table-test every supported limit: wall-clock, input/output/total tokens, and cost.
- [ ] Add boundary tests for equal-to limit, just over limit, multiple breaches, no budgets, and missing mandatory metric.
- [ ] Confirm RED.
- [ ] Implement pure budget evaluation after correctness verdict calculation.
- [ ] Return an ordered list of observed/limit/breach records. In `report`, never alter quality decision.
- [ ] In `mandatory`, map measured breach to `BUDGET_EXCEEDED`; map missing required metric to an inconclusive budget gate with `BUDGET_METRIC_MISSING`.
- [ ] Preserve the original failed correctness verdict even if budgets improve; budget checks may add failure but never erase it.
- [ ] Run focused acceptance/orchestrator tests and standard v4 commands.

Expected: report-only is observational; only explicitly mandatory and trustworthy limits affect routing.

Suggested checkpoint: `feat(v4): evaluate optional efficiency budgets`

## Task 5: Benchmark Manifest and Deterministic Fixture Corpus

**Requirements:** R69, R71, R73-R75
**Skills:** `@skill:test-driven-development`, `@skill:documentation-and-adrs`

**Files:**

- Create: `benchmarks/v4/manifest.json`
- Create: `benchmarks/v4/fixtures/pass-all/`
- Create: `benchmarks/v4/fixtures/config-missing/`
- Create: `benchmarks/v4/fixtures/gate-failed/`
- Create: `benchmarks/v4/fixtures/gate-nonpass/`
- Create: `benchmarks/v4/fixtures/evidence-invalid/`
- Create: `benchmarks/v4/fixtures/repair-progress/`
- Create: `benchmarks/v4/fixtures/repair-no-progress/`
- Create: `benchmarks/v4/fixtures/crash-resume/`
- Create: `benchmarks/v4/fixtures/concurrency-locks/`
- Create: `benchmarks/v4/fixtures/budget-modes/`
- Create: `benchmarks/v4/fixtures/false-success/`
- Modify: `test/v4/benchmark-manifest.test.ts`

- [ ] Write `representative_case_count`, `omni_self_case`, and `future_real_repo_slots` before adding the manifest.
- [ ] Define 10-15 enabled deterministic cases. Use table-driven variants within fixtures so all 14 approved scenarios are covered without exceeding 15 manifest cases.
- [ ] Require every deterministic case to use `adapter: "fake"`; reject a live adapter on fixture cases unless explicit live metadata is present.
- [ ] Add one enabled `projectKind: "omni"` self-dogfood case.
- [ ] Add exactly three disabled documented slots: JavaScript/full-stack, non-JavaScript, and unusual-test-config.
- [ ] Each disabled slot must include repository-path placeholder semantics, gate mapping/baseline notes, and activation checklist without claiming execution evidence.
- [ ] Keep fixtures minimal: quality config, requirements, fake adapter script/outcome, expected durable status/verdict, and only files required by the scenario.
- [ ] Validate every fixture path remains under `benchmarks/v4/fixtures` and every expected requirement/gate exists.
- [ ] Run manifest tests and standard v4 commands.

Recommended 14 deterministic manifest cases:

```text
01 pass-all
02 config-missing
03 mandatory-failed
04 mandatory-skipped
05 mandatory-inconclusive
06 timeout-or-invalid-evidence
07 repair-progress-success
08 repair-no-progress
09 crash-resume
10 independent-parallelism
11 workspace-write-serialization
12 report-budget-breach
13 mandatory-budget-breach-or-missing
14 false-success-prevention
```

Expected: representative deterministic coverage uses no model quota and includes honest disabled future slots.

Suggested checkpoint: `test(v4): add deterministic P3 benchmark corpus`

## Task 6: Isolated Benchmark Runner and Live Opt-In

**Requirements:** R70-R72, R78
**Skills:** `@skill:test-driven-development`, `@skill:systematic-debugging`

**Files:**

- Create: `src/v4/benchmark/runner.ts`
- Create: `test/v4/benchmark-runner.test.ts`
- Reuse: `src/v4/testing/fake-adapter.ts`
- Reuse: `src/v4/orchestration/run-orchestrator.ts`

- [ ] Write `isolated_workspace`, `fake_adapter_default`, `live_host_requires_opt_in`, and `correctness_precedes_efficiency`.
- [ ] Add tests proving source fixtures/repositories remain byte-identical, temp roots are unique, and cleanup occurs after success, assertion failure, abort, and thrown error.
- [ ] Add a spy adapter proving zero adapter factory, execute, and process invocations when any of the three opt-in conditions (manifest `liveModelCostOptIn=true`, env `OMNI_V4_ALLOW_MODEL_COST=1`, runner `allowModelCost=true`) is absent.
- [ ] Confirm RED.
- [ ] Implement `BenchmarkRunner` with injected filesystem/temp-root factory, orchestrator factory, adapter registry, clock, environment reader, and report writer.
- [ ] Validate manifest first; create an owned temporary root; copy only selected fixture/repository content; canonicalize and recheck containment after copy.
- [ ] Default deterministic cases to `FakeAdapter` and run each case independently so one failure cannot contaminate another workspace.
- [ ] Require all three exact conditions: manifest `liveModelCostOptIn=true`, env `OMNI_V4_ALLOW_MODEL_COST=1`, and runner `allowModelCost=true`; if any condition is missing, return an evidence-backed skipped case with `LIVE_BENCHMARK_NOT_APPROVED` and zero adapter factory/execute/process calls.
- [ ] Compare objective expected state, acceptance, false-success, recovery, and gate mapping before examining efficiency metrics.
- [ ] Mark any correctness mismatch failed with `BENCHMARK_EXPECTATION_MISMATCH`, even when time/tokens/cost improve.
- [ ] Remove only the owned temp workspace in `finally`; do not recursively delete unresolved/user paths.
- [ ] Run focused tests repeatedly and standard v4 commands.

Expected: benchmarks are isolated, deterministic by default, cost-safe, and correctness-first.

Suggested checkpoint: `feat(v4): run benchmarks in isolated workspaces`

## Task 7: Versioned JSON and Reproducible Markdown Reports

**Requirements:** R59, R76-R77
**Skills:** `@skill:test-driven-development`, `@skill:documentation-and-adrs`

**Files:**

- Create: `src/v4/benchmark/report.ts`
- Create: `test/v4/report.test.ts`
- Modify: `src/v4/benchmark/runner.ts`

- [ ] Write `stable_gate_order`, `json_and_markdown_outputs`, and `reproducible_from_inputs`.
- [ ] Add different gate completion orders with the same declaration order; require byte-stable semantic report content after removing isolated volatile metadata.
- [ ] Confirm RED.
- [ ] Define strict report schema version 1 containing manifest/config hashes, safe environment metadata, objective comparisons, completion reliability, false-success/failure totals, recovery outcomes, metrics, missing values, and live-cost approval state.
- [ ] Sort cases by manifest order, gates by declaration order, requirements by requirement order, and all unordered identifiers lexically.
- [ ] Write `report.json` first with checksum/atomic semantics appropriate to benchmark output.
- [ ] Implement Markdown as a pure render of parsed JSON report data; do not read event logs or recalculate metrics in the renderer.
- [ ] Keep volatile timestamps in a clearly marked metadata field excluded from semantic comparison hash.
- [ ] Write outputs to `.omni/v4/benchmarks/<benchmarkRunId>/report.json` and `summary.md` inside the benchmark result root.
- [ ] Run focused and standard v4 commands.

Expected: identical persisted inputs yield identical semantic JSON and Markdown, regardless of gate completion order.

Suggested checkpoint: `feat(v4): generate reproducible benchmark reports`

## Task 8: Full Deterministic Benchmark and Omni Self-Dogfood

**Requirements:** R73-R74, R78
**Skills:** `@skill:test-driven-development`, `@skill:verification-before-completion`

**Files:**

- Modify: `benchmarks/v4/manifest.json`
- Modify: `package.json`
- Modify if needed: `scripts/run-v4-tests.cjs`
- Create: `test/v4/benchmark-e2e.test.ts`

- [ ] Add npm scripts that separate deterministic/cost-free runs from any live run, for example `benchmark:v4` and `benchmark:v4:live`; the normal test suite must never invoke the live script.
- [ ] Write an end-to-end test that runs all enabled deterministic cases plus Omni self-dogfood in owned temp workspaces.
- [ ] Assert: 10-15 deterministic cases, zero false success, objective expectations all match, report-only budgets do not block, mandatory budgets fail closed, and source checkout remains unchanged.
- [ ] Confirm RED before wiring the script/runner.
- [ ] Implement the deterministic entry point with no required environment secrets and no network/model calls.
- [ ] For Omni self-dogfood, copy the minimum tracked repository needed to build/test v4; exclude `.git`, `node_modules`, `.omni/v4/runs`, existing benchmark outputs, and user untracked artifacts.
- [ ] Record the exact source revision and dirty-state flag as metadata; do not claim reproducibility across a changed source tree.
- [ ] Run deterministic benchmark twice and compare semantic report hashes.

```powershell
npm run benchmark:v4
npm run benchmark:v4
```

- [ ] Do not run `benchmark:v4:live` in implementation or CI without explicit user permission and cost opt-in.
- [ ] Run standard v4 commands.

Expected: the same source revision produces repeatable deterministic results, zero false success, and no writes to the source checkout beyond owned report output.

Suggested checkpoint: `test(v4): dogfood deterministic benchmark pipeline`

## Task 9: P3 Regression, Traceability, and Exit Gate

**Requirements:** R47-R79
**Skills:** `@skill:requesting-code-review`, `@skill:documentation-and-adrs`, `@skill:verification-before-completion`

**Files:**

- Modify if implementation differs: `docs/v4/adr/0005-quality-routing-and-evidence.md`
- Modify: `plans/v4/2026-08-20-p3-efficiency-spec.md` status only after all checks pass
- Verify: `.omni/sdlc/requirements.md`

- [ ] Create a traceability table for R47-R79 with exact test names and actual results.
- [ ] Review all concurrency code for leaked promises, unhandled rejection, double settlement, lock starvation, and launch-after-cancel.
- [ ] Review all metrics/report fields for accidental secret/environment persistence and missing-to-zero coercion.
- [ ] Review benchmark cleanup targets by resolved absolute path before any recursive removal.
- [ ] Prove agent adapter concurrency stays at 1 while gate concurrency reaches configured bounds.
- [ ] Run focused P3 tests:

```powershell
npx tsx --test test/v4/gate-scheduler.test.ts test/v4/metrics.test.ts test/v4/budget-policy.test.ts
npx tsx --test test/v4/benchmark-manifest.test.ts test/v4/benchmark-runner.test.ts test/v4/report.test.ts
npx tsx --test test/v4/benchmark-e2e.test.ts
```

- [ ] Run the deterministic benchmark twice and record case count, false-success count, expectation mismatches, semantic hashes, and skips.
- [ ] Run the complete exit gate:

```powershell
npm run typecheck:v4
npm run build:v4
npm run test:v4
npm run benchmark:v4
npm test
git diff --check
git status --short
```

- [ ] Mark the P3 spec `Implemented` only when R47-R79 pass and P0-P2/v3 regressions are green.
- [ ] Produce a handoff containing scheduler invariants, metric availability, budget behavior, benchmark evidence, disabled slots, exact command results, risks, and rollback.
- [ ] Do not commit. Report suggested final checkpoint: `feat(v4): complete P3 efficiency and dogfood foundation`.

## P3 Exit Gate

All must be true:

- R1-R78 pass via active exact file tests and R79 passes via exact command `npm test` (`test.skip` and `todo` are not counted as evidence).
- Skips are accurately accounted: v4 unit suite contains 2 environment/cost-scoped skips not mapping mandatory targets (`test/v4/host-smoke.test.ts` when live host/cost prerequisites are absent and `test/v4/process-runner.test.ts` for POSIX signal behavior on Windows), and benchmark contains 3 disabled future slots.
- Agent steps have observed peak concurrency 1.
- Gate peak concurrency never exceeds configuration and respects all locks.
- Parallel and sequential verdict/evidence mappings are equivalent.
- Missing usage remains missing, not zero.
- Report-only budgets never change acceptance.
- Mandatory breach/missing metrics fail closed.
- Deterministic case count is 10-15 and false-success count is zero.
- Omni self-dogfood is repeatable from the same revision.
- Cross-run source reproducibility requires clean Git revision; dirty/unavailable source metadata is marked NOT CLAIMABLE.
- Live host invocations are zero unless all 3 opt-in conditions are satisfied.
- `npm test` passes, preserving P0-P2 and v3.

## P3 Stop Conditions

Stop and report `BLOCKED` instead of weakening invariants when:

- P2 contracts or acceptance evidence are incomplete;
- parallel execution changes verdict or evidence correlation;
- a workspace-write gate can overlap any other gate;
- the scheduler would require concurrent agent steps or concurrent run transitions;
- metrics require guessing unavailable provider values;
- a benchmark cannot be isolated from the source checkout;
- live model cost would be incurred without all three required opt-in approvals;
- an efficiency improvement causes any correctness regression.

## P3 Handoff Template

```text
Status: COMPLETE | BLOCKED
Requirements: R47-R79 passed/failed count
Changed files: exact paths
Scheduler: max configured; observed peak; lock tests
Metrics: available fields; missing fields; no zero coercion confirmation
Budgets: report and mandatory results
Benchmarks: case count; false success/failure; semantic hashes
Dogfood: source revision; dirty flag; result; disabled slots
Verification: exact command -> actual result
Live invocations/model cost: zero unless explicitly approved
Known risks: bounded list
Rollback: modules/config/report format implications
Suggested checkpoint only: <message>
Commit/push performed: no
```

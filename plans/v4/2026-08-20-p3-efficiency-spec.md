# Omni v4 P3 Efficiency Design Specification

**Status:** Approved design, pending implementation-plan review

**Date:** 2026-08-20

**Priority:** P3 efficiency

**Roadmap slice:** Milestone 6 foundation — bounded gate concurrency, metrics, benchmark, and initial dogfood

## 1. Goal

Measure and improve Omni v4 efficiency without weakening P0-P2 correctness. P3 adds bounded concurrency for independent quality gates, complete run metrics, optional enforceable budgets, deterministic benchmark fixtures, and Omni self-dogfood. Agent steps remain serial.

The normative atomic checklist is `.omni/sdlc/requirements.md` R47-R79.

## 2. Success criteria

- Independent gates run concurrently within explicit safety bounds.
- Parallel and sequential modes produce identical acceptance decisions and evidence mappings.
- Metrics distinguish unavailable values from zero.
- Budgets are report-only by default and block only when explicitly mandatory.
- The benchmark suite contains 10-15 deterministic cases and an enabled Omni self-dogfood case.
- Live hosts never run without explicit opt-in.
- Correctness regression always outweighs speed/token improvement.

## 3. Non-goals

- Concurrent agent steps or multiple run-state transitions in flight.
- Distributed workers, queues, or cross-machine scheduling.
- Automatic model selection based on price.
- Provider pricing tables in core.
- Mandatory completion of the three external real-repository dogfood slots.
- A dashboard or hosted analytics service.
- Evidence caching across changed workspaces.

## 4. Scheduler architecture

Create `src/v4/quality/gate-scheduler.ts`. It accepts the validated gate DAG and invokes the P2 `GateRunner`; it does not interpret process output or acceptance semantics.

```ts
interface GateSchedulerOptions {
  readonly maxParallelGates: number; // default 2, valid 1..8
}

interface GateScheduleResult {
  readonly results: ReadonlyMap<GateId, GateResult>;
  readonly peakParallelism: number;
  readonly totalQueueMs: number;
}
```

### 4.1 DAG validation

Before any process starts, reject:

- duplicate gate IDs;
- missing dependency IDs;
- self-dependency;
- dependency cycles;
- duplicate dependencies;
- invalid concurrency keys.

### 4.2 Eligibility

A gate is ready only when every dependency has completed with `passed`. A failed or non-pass dependency prevents launch and yields an explicit skipped/inconclusive result according to mandatory policy; it is never silently omitted.

### 4.3 Locks

- `read-only` gates may run concurrently.
- Equal non-empty `concurrencyKey` values are mutually exclusive.
- `workspace-write` gates acquire the global workspace lock and run alone.
- The scheduler never executes an agent adapter.

### 4.4 Failure behavior

Running gates are allowed to settle when another gate fails. No new dependent gate starts. Independent ready gates continue so the report contains useful diagnostics. External cancellation aborts active gates and marks unstarted gates explicitly.

Completion events may reflect actual timing. Bundles and reports sort by manifest declaration order, so report comparison remains stable.

## 5. Metrics contracts

Create `src/v4/metrics/contracts.ts`:

```ts
interface RunMetrics {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly actualStatus: string;
  readonly reportedStatus: string;
  readonly falseSuccess: boolean;
  readonly falseFailure: boolean;
  readonly gateCounts: Readonly<Record<GateStatus, number>>;
  readonly retryCount: number;
  readonly repairCount: number;
  readonly resumeCount: number;
  readonly userInterventionCount: number;
  readonly wallClockMs: number;
  readonly summedGateDurationMs: number;
  readonly gateQueueMs: number;
  readonly peakParallelism: number;
  readonly measuredSpeedup?: number;
  readonly usage?: NormalizedUsage;
  readonly adapter?: AdapterIdentity;
  readonly missingMetrics: readonly string[];
}
```

`MetricsCollector` derives metrics from durable events, evidence bundles, and adapter native metadata. Console prose is not a metrics source. Missing provider values are absent and listed in `missingMetrics`; they are never coerced to zero.

`measuredSpeedup` is `summedGateDurationMs / wallClockMs` for the quality window and is omitted when the denominator is zero or inputs are incomplete.

## 6. Budget policy

Extend quality configuration:

```json
{
  "maxParallelGates": 2,
  "budgets": {
    "mode": "report",
    "wallClockMs": 600000,
    "totalTokens": 200000,
    "costUsd": 5
  }
}
```

Supported limits are nonnegative finite `wallClockMs`, `inputTokens`, `outputTokens`, `totalTokens`, and `costUsd`.

- `report`: breaches appear in metrics/report and cannot change acceptance.
- `mandatory`: breach produces `BUDGET_EXCEEDED`; a required unavailable metric produces `BUDGET_METRIC_MISSING` and an inconclusive mandatory budget gate.
- Omitted budgets create no synthetic limits.

Budget evaluation happens after correctness evidence. A lower cost or faster run never compensates for a failed requirement.

## 7. Benchmark contracts

Create strict manifest types:

```ts
interface BenchmarkManifest {
  readonly schemaVersion: 1;
  readonly cases: readonly BenchmarkCase[];
}

interface BenchmarkCase {
  readonly id: string;
  readonly enabled: boolean;
  readonly projectKind: "omni" | "javascript" | "non-javascript" | "unusual-tests" | "fixture";
  readonly fixturePath?: string;
  readonly repositoryPath?: string;
  readonly adapter: "fake" | "codex" | "claude" | "antigravity";
  readonly expected: BenchmarkExpectation;
  readonly tags: readonly string[];
}
```

Reject duplicate IDs, path escape, enabled external cases without a resolved repository, live adapter without opt-in, and expectations that omit actual/acceptance status.

## 8. Deterministic benchmark set

Check in 10-15 cases under `benchmarks/v4/fixtures/`. The manifest must cover:

1. all mandatory gates pass;
2. missing quality config;
3. mandatory gate failed;
4. mandatory gate skipped;
5. mandatory gate inconclusive;
6. gate timeout/malformed evidence;
7. repair makes progress and succeeds;
8. repair makes no progress;
9. crash/resume during quality cycle;
10. independent gate parallelism;
11. workspace-write serialization;
12. report-only budget breach;
13. mandatory budget breach/missing metric;
14. explicit false-success prevention.

The final count must remain between 10 and 15; tightly related variants may share a fixture with table-driven expectations.

## 9. Benchmark execution

`BenchmarkRunner`:

1. validates the manifest;
2. creates an isolated temporary workspace;
3. copies only the selected checked-in fixture or creates an isolated Omni self-workspace;
4. uses `FakeAdapter` unless an enabled case explicitly selects a live host;
5. runs the orchestrator and quality subsystem;
6. compares actual durable state/evidence with objective expectations;
7. collects metrics;
8. writes JSON and Markdown reports;
9. cleans temporary state in `finally`.

Live cases require a three-part opt-in: manifest `liveModelCostOptIn=true`, environment variable `OMNI_V4_ALLOW_MODEL_COST=1`, and runner option `allowModelCost=true`. If any condition is missing, zero adapter factory invocations, zero adapter execute calls, and zero process invocations occur, and the case is skipped with explicit evidence without attempting a host invocation.

## 10. Dogfood scope

The manifest contains:

- one enabled Omni self-dogfood case;
- one disabled JavaScript/full-stack repository slot;
- one disabled non-JavaScript repository slot;
- one disabled partial/unusual-test-config repository slot.

Disabled slots document required path, expected test command/gate mapping, baseline reference, and activation checklist. They are preparation artifacts, not claimed dogfood evidence. In addition, the v4 unit test suite contains 2 environment/cost-scoped skips not mapping mandatory targets (`test/v4/host-smoke.test.ts` when live host/cost prerequisites are absent and `test/v4/process-runner.test.ts` for POSIX signal behavior on Windows).

## 11. Reports

Create:

```text
.omni/v4/benchmarks/<benchmarkRunId>/report.json
.omni/v4/benchmarks/<benchmarkRunId>/summary.md
```

The JSON report stores manifest/config hashes, environment, case results, objective expectation comparisons, reliable completion rate, false-success/false-failure totals, recovery outcomes, metrics, missing values, Git metadata, and live-cost approval state.

The Markdown summary is derived only from the JSON report. Re-generating it from identical persisted inputs produces identical semantic content; volatile generation timestamps are isolated in metadata and excluded from comparison hashes. Cross-run source-level reproducibility requires a clean Git revision (`isDirty=false`); runs with unavailable Git metadata or a dirty working tree explicitly mark source reproducibility as `NOT CLAIMABLE`.

## 12. Error taxonomy

Stable P3 codes:

```text
GATE_DEPENDENCY_INVALID
GATE_DEPENDENCY_CYCLE
BUDGET_METRIC_MISSING
BUDGET_EXCEEDED
BENCHMARK_MANIFEST_INVALID
BENCHMARK_EXPECTATION_MISMATCH
BENCHMARK_WORKSPACE_UNSAFE
LIVE_BENCHMARK_NOT_APPROVED
```

## 13. Verification strategy

- DAG validation and controlled-promise concurrency tests without timing sleeps.
- Workspace and concurrency-key lock tests.
- Sequential/parallel equivalence tests.
- Injected-clock metrics tests.
- Missing-usage and budget-mode tests.
- Manifest/path/opt-in tests.
- Temp-workspace isolation and cleanup tests.
- Stable JSON/Markdown report tests.
- Full deterministic benchmark execution.
- Omni self-dogfood in a temporary workspace.
- Full P0-P2 and v3 regression.

## 14. P3 exit gate

P3 is complete only when R47-R79 pass via active exact file tests (R1-R78) and exact command `npm test` (R79) where `test.skip` and `todo` do not count as evidence, the deterministic benchmark suite reports zero false success, parallel and sequential verdicts are equivalent, report-only budgets never block, mandatory budgets fail closed, Omni self-dogfood is reproducible, live cases remain opt-in under the three-part guard, and no P0-P2 correctness regression is accepted for an efficiency gain.

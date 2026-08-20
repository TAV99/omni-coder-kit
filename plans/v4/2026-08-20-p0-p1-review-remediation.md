# Omni v4 P0/P1 Review Remediation Plan

> **Status:** P0/P1 review failed; implementation must not be accepted or promoted yet.
>
> **Purpose:** This is an execution handoff for coding agents. It describes confirmed defects, exact ownership boundaries, failing tests to add first, implementation constraints, verification commands, acceptance gates, and rollback guidance.
>
> **Repository state at review:** branch `v4`; P0 is committed through `c0c7f60`; P1 is staged but uncommitted. Preserve the index and all user changes. Do not reset, checkout, commit, push, deploy, or run model-cost smoke tests without explicit user approval.

## 1. Review scope and verdict

Reviewed range:

- P0: `484cdf8..c0c7f60`
- P1: staged working-tree patch on top of `c0c7f60`
- Source of truth:
  - `plans/v4/2026-08-15-p0-correctness-safety.md`
  - `plans/v4/2026-08-16-p1-agent-compatibility.md`

Fresh baseline on Windows `win32-x64`:

- `npm audit --audit-level=high`: PASS, 0 vulnerabilities
- `npm run typecheck:v4`: PASS
- `npm run build:v4`: PASS
- `npm run test:v4`: PASS, 86 tests; 84 passed; 2 skipped
- `npm test`: PASS, v3 976 passed plus v4 84 passed/2 skipped
- `git diff --cached --check`: PASS
- Live host smoke: NOT RUN because it requires explicit cost approval

Verdict:

- **P0: NOT ACCEPTED.** Replay can construct false state, event append is not compare-and-append across store instances, timeout is not authoritative, unavailable adapters can execute, and recovery loses required directives at documented crash cut-points.
- **P1: NOT ACCEPTED.** Process lifecycle, compatibility probing, capability advertisement, native resume, strict parsing, shared contract coverage, and smoke evidence do not meet the approved plan.
- Green tests are not sufficient evidence because several required assertions are absent or weakened.

## 2. Confirmed findings

Severity scale:

- **S0:** false success, duplicate execution, or integrity loss; release blocker
- **S1:** fail-closed/runtime contract breach; release blocker
- **S2:** verification/evidence gap; must close before P1 completion

### F-P0-01 — S0 — Replay does not validate same-run causation

Evidence:

- `src/v4/core/reducer.ts:36-140` checks sequence and allowed phase pairs but not `event.runId`, in-flight step/operation correlation, current phase on `step.started`, or terminal-event causation.
- `src/v4/storage/event-store.ts:175-194` replays without an event-history causation validator.
- Approved plan requires `causedByEventId` to reference an earlier matching event in the same run (`plans/v4/2026-08-15-p0-correctness-safety.md:710,776`).
- Repro accepted a `run.transitioned` event carrying `runId: "run-b"` into `run-a`, with a nonexistent `causedByEventId`, and returned phase `PLAN`.

Impact: a forged or corrupted log can manufacture a forward transition without a validated successful step.

### F-P0-02 — S0 — Event compare-and-append lock is instance-local

Evidence:

- `src/v4/storage/event-store.ts:28-52` stores the promise queue on each `FileEventStore` instance.
- The plan requires serialization per resolved log path across the process (`plans/v4/2026-08-15-p0-correctness-safety.md:877,896`).
- Repro using two instances and the same `expectedSequence` produced two successful appends in 36 of 50 iterations. Both events used sequence `1`, leaving a corrupt log.
- `append()` also filters interior blank lines and does not validate the existing `0..n` sequence before writing (`src/v4/storage/event-store.ts:72-88`).

Impact: concurrent controllers in the same Node process can both claim the same sequence and corrupt the source of truth.

### F-P0-03 — S0 — Controller timeout is advisory, not authoritative

Evidence:

- `src/v4/core/controller.ts:134-160` aborts a signal but still awaits `adapter.execute()` directly.
- It never calls `adapter.cancel(request.operationId)` when the deadline expires.
- Repro with an adapter that ignores `AbortSignal` remained pending after a 20 ms timeout plus a 150 ms watchdog; cancel count remained `0`.
- The P0 plan requires timeout normalization and cancellation correlation (`plans/v4/2026-08-15-p0-correctness-safety.md:1112,1121`).

Impact: a run can hang forever; a caller may retry externally while the first protected operation is still executing.

### F-P0-04 — S1 — Unavailable/incompatible adapters can execute

Evidence:

- `src/v4/policy/default-policy.ts:53-71` checks required capabilities and elevation only; it ignores `probe.available` and adapter identity.
- `src/v4/core/controller.ts:70-76` delegates the complete decision to that policy.
- Repro with `FakeAdapter({ available: false })` and no required capabilities executed the adapter once and only blocked after the adapter result.
- Each P1 adapter maps compatibility status `incompatible` to `available: true` via `status !== "unavailable"`.

Impact: fail-closed preflight can be bypassed by an empty capability request or direct adapter construction.

### F-P0-05 — S0 — Recovery loses required crash-cut directives

Evidence:

- `src/v4/core/recovery.ts:249-275` handles only failure-policy `block`, not `retry`.
- Resume-policy and preflight-policy cut-points are not handled before the fallback at `src/v4/core/recovery.ts:323`.
- Repro after `step.failed -> policy.decided(retry)` returned `continue`; the approved result is `rerun`.
- Repro after `policy.decided(preflight deny)` returned `continue`; the approved result is a durable `run.blocked`.
- `src/v4/testing/fault-scenarios.ts:872-876` explicitly accepts either `continue` or `rerun`, weakening the approved assertion.

Impact: after a crash, work can be silently stranded or a denied operation can remain non-terminal.

### F-P0-06 — S1 — Recovery correlates attempts by `stepId` only

Evidence:

- `src/v4/core/recovery.ts:110-118` uses the first matching `step.started` and all artifacts ever produced by the step.
- `src/v4/core/recovery.ts:180-195` again uses the first `step.started`, reconstructs an incomplete request, defaults missing side effect to `read-only`, and casts it with `as any`.
- A repeated step with a new `operationId` can therefore inherit an old workspace, side-effect class, or stale artifact.

Impact: recovery can verify the wrong artifact set or misclassify a protected operation as replayable.

### F-P1-01 — S1 — Pre-aborted process requests throw before cleanup initialization

Evidence:

- `src/v4/process/node-process-runner.ts:18-23` calls `cleanup()` from `safeResolve()`.
- `cleanup` is initialized only at `src/v4/process/node-process-runner.ts:90-98`.
- The pre-aborted branch at `src/v4/process/node-process-runner.ts:78-81` calls `safeResolve()` first.
- Repro returns `ReferenceError: Cannot access 'cleanup' before initialization` instead of a structured `aborted` result.

Impact: cancellation violates the non-throwing `ProcessRunner` contract and can leave controller state in-flight.

### F-P1-02 — S1 — Timeout/abort resolves before child termination is proven

Evidence:

- `src/v4/process/node-process-runner.ts:50-75` sends `SIGTERM` and resolves immediately.
- There is no bounded wait for `close`, no escalation to `SIGKILL`, and no process-tree termination contract.
- Existing tests assert only `termination`; they do not prove the fixture process is gone (`test/v4/process-runner.test.ts:50-79`).
- The approved plan explicitly requires no leftover fixture process (`plans/v4/2026-08-16-p1-agent-compatibility.md:225,247`).

Impact: an adapter can return timeout while its child continues modifying the workspace.

### F-P1-03 — S1 — Compatibility probe can promote a failed probe

Evidence:

- `src/v4/compatibility/probe.ts:35-115` treats only `spawn-error` specially and scans stdout/stderr regardless of termination or exit code.
- Repro with successful version output and a timed-out help result containing the required flag returned `first-class`.
- Adapter probes ignore their `signal` parameter.

Impact: timeout, abort, output-limit, signal, or nonzero probe execution can be reported as compatible or first-class.

### F-P1-04 — S1 — Capabilities are hardcoded and over-advertised

Evidence:

- Capability arrays are static in:
  - `src/v4/adapters/codex/adapter.ts:26-35`
  - `src/v4/adapters/claude/adapter.ts:28-37`
  - `src/v4/adapters/antigravity/adapter.ts:24-31`
- Repro with a Claude tool policy containing no write tools and no shell patterns still advertised `workspace.write` and `shell`, contrary to `plans/v4/2026-08-16-p1-agent-compatibility.md:686-688`.
- Repro with a Codex help probe missing every required flag still returned `available: true` and advertised all capabilities.
- `streaming`, `native-resume`, and `usage` are advertised without the per-capability flag/fixture evidence required by the plan.

Impact: policy authorization is based on capabilities that the current host invocation cannot safely provide.

### F-P1-05 — S1 — Native resume is silently ignored for Codex and Antigravity

Evidence:

- `src/v4/adapters/codex/command.ts:6-42` accepts `resumeSessionId` but never reads it.
- Repro produced byte-equivalent Codex invocations with and without a resume ID.
- `src/v4/adapters/antigravity/adapter.ts:60-101` does not propagate `context.resumeSessionId` to its builder.
- Local probes on 2026-08-20 show Codex `0.147.0` supports `codex exec resume`, Claude `2.1.185` supports `--resume`, and Antigravity `1.1.16` exposes `--conversation`; those host-specific paths require separate argv builders and tests.

Impact: a caller requesting native resume receives a fresh execution while audit metadata says resume was requested.

### F-P1-06 — S1 — Codex parser accepts malformed/incomplete JSONL

Evidence:

- `src/v4/adapters/codex/parser.ts:117-138` skips non-JSON lines and catches malformed JSON without failing.
- It never requires a `turn.completed` event.
- Repro returned `succeeded` for both malformed JSONL and JSONL containing only `thread.started`.
- This directly violates `plans/v4/2026-08-16-p1-agent-compatibility.md:472-478`.
- Claude and Antigravity envelope parsing also uses `any` rather than strict native-envelope schemas.

Impact: truncated or spoofed native output can be accepted as successful execution metadata.

### F-P1-07 — S2 — Shared contract and smoke gates are incomplete

Evidence:

- `src/v4/testing/adapter-contract.ts:14-95` tests probe shape, nonzero exit, and idempotent cancel only; `options.elevatedFlag` is unused.
- Required safe/elevated argv, timeout, abort, malformed output, model-authored `native`, native metadata, and correlation cases are absent.
- `test/v4/host-smoke.test.ts:17-75` calls an adapter directly, not the real P0 controller/artifact pipeline; cleanup is not in `finally`; it does not prove workspace isolation or checksum/phase evidence.
- `compatibility/v4/README.md` contains promotion rules but no per-host dated evidence/status/limitations table.
- All hosts remain experimental in `compatibility/v4/hosts.json`, which is conservative, but P1 completion is not proven.

Impact: the suite can be green while the approved adapter safety contract remains unimplemented.

## 3. Root-cause model

Do not patch findings one by one without preserving these root causes:

1. **Historical invariants are split between reducer and replay.** State-only reduction cannot validate references to prior events; replay needs an explicit history validator.
2. **Process completion is confused with termination intent.** Sending an abort/kill signal is not proof that the child and its descendants stopped.
3. **Compatibility evidence is collapsed into hardcoded adapter constants.** Capability decisions must be derived from successful probes, parser fixtures, and active configuration.
4. **Recovery reconstructs context that was not durably stored.** A recovery decision must use an exact attempt snapshot, never first-match lookup or permissive defaults.
5. **Tests check output shape more often than safety semantics.** Each contract must include negative paths and exact side-effect assertions.

## 4. Execution rules for coding agents

Every task below follows RED -> GREEN -> REFACTOR:

1. Add the smallest failing automated test described by the card.
2. Run only that test and capture the expected failure.
3. Implement the root-cause fix inside the listed ownership boundary.
4. Re-run the targeted test.
5. Run `npm run typecheck:v4` and `npm run test:v4` before handoff.
6. Do not weaken an assertion, convert a failure to skip, or use `any` to bridge a contract.
7. Do not change v3, add dependencies, commit, push, or run live/model-cost smoke.
8. Report files changed, commands, exact pass/fail counts, remaining risks, and next task dependency.

Because P1 is already staged, agents must inspect both views before editing:

```powershell
git diff --cached -- <owned-files>
git diff -- <owned-files>
```

Do not run reset/checkout to “clean” the worktree. Leave staging decisions to the user/lead agent.

## 5. Remediation task graph

```text
R0 contract decisions
├─ R1 replay integrity ── R2 event-store CAS
├─ R3 controller preflight/timeout
└─ R4 recovery state machine
   └──────────────┬───────────────┘
                  v
             P0 acceptance
                  |
R5 process lifecycle ── R6 probe/capabilities
                         ├─ R7 Codex strict adapter
                         ├─ R8 Claude strict adapter
                         └─ R9 Antigravity strict adapter
                                      |
                         R10 shared contracts/integration
                                      |
                         R11 smoke evidence/docs
                                      |
                              P1 acceptance
```

Parallelization:

- After R0, R1, R3, R4, and R5 may be implemented in parallel because their source ownership does not overlap.
- R2 depends on the common event decoder from R1.
- R6 depends on R5 because probes use `ProcessRunner` termination semantics.
- R7/R8/R9 depend on R6 and should use separate host-owned files.
- R10 begins only after R3-R9 are green.
- R11 is last and requires explicit user approval for any paid live run.

## 6. Detailed task cards

### R0 — Lock remediation contracts

**Owner:** architecture/lead agent

**Files:**

- Create: `docs/v4/adr/0004-replay-process-compatibility-invariants.md`
- Modify only if required by the decision: `src/v4/contracts/policy.ts`, `src/v4/contracts/event.ts`

**Decisions to record:**

1. Replay validates same-run identity, exact sequence, causation target type, and step/operation correlation.
2. A process result is returned only after the child termination boundary is reached.
3. Unsupported native resume fails closed; it never falls back to a new session.
4. Recovery policy input is durably reconstructible. Prefer a narrow `PolicyStepContext` containing only fields actually used by policy rather than persisting raw prompts.
5. `AdapterProbe.available` means executable and compatible enough to construct; `experimental` remains separately gated in the registry.

**Acceptance:** ADR identifies compatibility/migration impact for unreleased v4 schemas; no implementation code yet.

### R1 — Enforce replay history and causation integrity

**Owner:** P0 replay agent

**Files:**

- Modify: `src/v4/core/reducer.ts`
- Modify: `src/v4/storage/event-store.ts`
- Modify if schema validation needs shared helpers: `src/v4/contracts/event.ts`
- Add/modify tests: `test/v4/transitions.test.ts`, `test/v4/event-store.test.ts`

**RED tests:**

- Reject any non-initial event whose `runId` differs from the initial event.
- Reject `step.started.payload.phase !== state.phase`.
- Reject `step.succeeded|failed|blocked|cancelled|interrupted` unless step ID and operation ID match the current in-flight attempt.
- Reject `artifact.recorded` unless record run ID and producer step match the current attempt.
- Reject `run.transitioned` unless `causedByEventId` points to an earlier `step.succeeded` with the same run, step, and operation.
- Reject `run.blocked` and `run.cancelled` when their cause is missing, later, cross-run, or the wrong event type.
- Preserve valid replay behavior for every normal phase transition.

**Implementation:**

- Keep `reduceEvent()` deterministic and enforce state-local invariants there.
- Add a single ordered history validator used by `replayRun()` for reference/causation checks that require prior events.
- Convert all invariant failures read from disk to `CorruptEventLogError` with line/sequence/type context.
- Do not sort or repair corrupt logs.

**Targeted command:**

```powershell
node --import tsx --test test/v4/transitions.test.ts test/v4/event-store.test.ts
```

**Expected:** every invalid fixture rejects; the cross-run/nonexistent-cause repro cannot reach `PLAN`.

### R2 — Make event append process-local compare-and-append

**Owner:** P0 storage agent

**Depends on:** R1

**Files:**

- Modify: `src/v4/storage/event-store.ts`
- Modify: `test/v4/event-store.test.ts`

**RED tests:**

- Create two independent `FileEventStore` instances for one `projectDir`; two simultaneous appends at the same expected sequence yield exactly one fulfillment and one `EventSequenceConflictError`.
- Repeat the race enough times to detect accidental instance-local locking without relying on timing sleeps.
- Existing log with an interior blank line, sequence gap, duplicate sequence, wrong run ID, or invalid causation rejects before append and remains byte-identical.

**Implementation:**

- Move the queue to module scope and key it by normalized/resolved absolute event-log path.
- Reuse one strict NDJSON decoder for `read()` and append preflight.
- Inside the shared critical section: decode/validate full log, compare sequence, check event ID, append one compact line, sync, close.
- Retain the documented P0 boundary: cross-process writers remain unsupported; do not add a lock service.

**Expected:** the prior 50-iteration repro reports `bothSucceeded: 0`.

### R3 — Make controller preflight and deadlines fail closed

**Owner:** P0 controller/policy agent

**Files:**

- Modify: `src/v4/policy/default-policy.ts`
- Modify: `src/v4/core/controller.ts`
- Modify: `test/v4/policy.test.ts`, `test/v4/controller.test.ts`

**RED tests:**

- `probe.available === false` produces `policy.decided(deny)` then `run.blocked`, with no `step.started` and zero adapter calls.
- Probe adapter ID mismatch denies.
- Invalid probe shape denies/normalizes safely at the adapter boundary.
- An adapter ignoring `AbortSignal` settles as a structured timeout within deadline plus a documented cancellation grace; `cancel(operationId)` is called exactly once.
- A late adapter resolve/reject cannot append a second terminal event or create an unhandled rejection.

**Implementation:**

- Validate probe output with `AdapterProbeSchema` before policy evaluation.
- Deny unavailable probes and adapter-ID mismatch before capability checks.
- Race execution against a controller-owned deadline; on deadline abort the signal and call `adapter.cancel(operationId)` once.
- Normalize timeout into the existing stable failed result and persist the standard failure-policy events.
- Keep one adapter execution per controller call.

**Acceptance:** unavailable repro shows `adapterCalls: 0`; timeout repro settles and shows `cancelCalls: 1`.

### R4 — Replace recovery fallthrough with an exhaustive cut-point state machine

**Owner:** P0 recovery agent

**Depends on:** R0 and R1

**Files:**

- Modify: `src/v4/core/recovery.ts`
- Modify: `src/v4/testing/fault-scenarios.ts`
- Modify: `test/v4/recovery.test.ts`, `test/v4/fault-injection.test.ts`
- Modify contracts only as approved in R0.

**RED tests:**

- Failure policy `retry` -> exact `rerun` with previous operation ID.
- Failure policy `block` -> append one `run.blocked`.
- Resume policy `retry` -> exact `rerun`; resume policy `block` -> append one `run.blocked`.
- Preflight `deny` -> append one `run.blocked`; preflight `allow` before `step.started` -> continue safely without execution.
- `step.succeeded` roll-forward verifies exactly the artifact IDs in that success result, from the same step and operation attempt.
- Missing or extra/stale artifact records block; zero artifacts never vacuously validate.
- Repeated step IDs with distinct operation IDs use the nearest exact matching start event.
- Calling `resume()` twice is idempotent and does not duplicate terminal events.
- Protected side effects never default to `read-only` when context is missing; incomplete context blocks.

**Implementation:**

- Replace the final generic fallthrough with an exhaustive dispatcher over valid last-event/cut-point combinations.
- Resolve attempts by the tuple `(runId, stepId, operationId)` and ordered event boundaries.
- Remove `dummyReq as any` and all permissive defaults.
- Reconstruct policy input from the durable context selected in R0.
- Every appended recovery event must reference an existing earlier same-run cause.

**Acceptance:** restore the exact approved assertions; specifically remove `continue || rerun` from `crashAfterRetryDecision`.

### R5 — Make `ProcessRunner` settle only after termination

**Owner:** P1 process agent

**Files:**

- Modify: `src/v4/process/node-process-runner.ts`
- Modify if needed: `src/v4/process/types.ts`
- Modify: `test/fixtures/v4/process-fixture.cjs`
- Modify: `test/v4/process-runner.test.ts`

**RED tests:**

- Pre-aborted signal returns `termination: "aborted"` and never spawns.
- Synchronous/asynchronous spawn error resolves once and does not throw.
- On timeout and abort, wait for child close; verify the PID is gone and a delayed sentinel file is never written after `run()` returns.
- A fixture that ignores graceful termination is force-killed after a short injected grace period.
- Process descendants are terminated or the unsupported platform limitation is explicit and tested.
- Output-limit follows the same wait-for-close rule.

**Implementation:**

- Define cleanup before any path can settle; prefer function declarations or initialize callbacks before spawn.
- Track desired termination reason separately from the eventual `close` event.
- Request graceful termination, wait a bounded grace period, escalate, then settle on `close`.
- Keep `shell: false`, stdout/stderr separation, byte limits, and idempotent settlement.
- Use argv-only platform helpers; never interpolate untrusted command strings.

**Acceptance:** no rejected promise, no child/descendant left running, and exact termination reason remains stable.

### R6 — Make compatibility probes and capabilities evidence-derived

**Owner:** P1 compatibility agent

**Depends on:** R5

**Files:**

- Modify: `src/v4/compatibility/probe.ts`, `src/v4/compatibility/manifest.ts`
- Modify: `compatibility/v4/hosts.json`
- Modify: all three adapter `probe()` methods
- Modify: `test/v4/compatibility.test.ts`, `test/v4/adapter-registry.test.ts`

**RED tests:**

- Version/help timeout, abort, output-limit, signal, or nonzero exit can never be `first-class`.
- Spawn error is `unavailable`; unusable probe execution is `incompatible` with diagnostics.
- Probe signal reaches both runner calls.
- Adapters map `unavailable` and `incompatible` to `available: false`.
- Every advertised capability has required successful flag evidence and parser/config evidence.
- Experimental status still requires explicit `allowExperimental: true`.

**Implementation:**

- Require `termination === "exited" && exitCode === 0` before parsing version/help output.
- Preserve status separately from Boolean availability at the registry boundary.
- Add explicit per-capability evidence mapping or a host-local derivation function; do not use a static “all capabilities” constant.
- Do not mark a capability proven merely because the CLI generally supports it; the current invocation/configuration must support it.
- Update the manifest only from fresh local version/help output. Keep evidence booleans false until R11.

**Current local facts to preserve:**

- Codex `0.147.0`
- Claude Code `2.1.185`
- Antigravity `1.1.16` (manifest currently says `1.1.13`; update status/evidence accordingly, but do not promote)

### R7 — Make Codex parser and native resume strict

**Owner:** Codex adapter agent

**Depends on:** R6

**Files:**

- Modify: `src/v4/adapters/codex/command.ts`, `parser.ts`, `adapter.ts`
- Modify: `test/v4/codex-command.test.ts`, `codex-parser.test.ts`, `codex-adapter.test.ts`
- Modify fixtures under `test/fixtures/v4/hosts/codex/`

**RED tests:**

- Every non-empty JSONL line must parse; malformed JSONL fails.
- Missing, duplicate, or non-success completion event fails.
- Usage/session fields must pass strict native-event schemas and nonnegative finite-number checks.
- `resumeSessionId` produces a distinct `codex exec resume` invocation; it is never silently ignored.
- Safe/elevated flags are valid for the resume subcommand ordering proven by current `--help` output.
- If resume cannot preserve the requested permission mode, return a non-success result and omit `native-resume` capability.
- Result-file model output containing `native` remains rejected.

**Implementation:**

- Parse JSONL as strict discriminated native events; require exactly one valid completion event.
- Keep model outcome authoritative only from the schema-validated result file.
- Build new-session and resume argv as separate explicit branches.
- Only advertise streaming/resume/usage when the corresponding builder/parser tests pass.

### R8 — Make Claude envelope and configured capabilities strict

**Owner:** Claude adapter agent

**Depends on:** R6

**Files:**

- Modify: `src/v4/adapters/claude/command.ts`, `parser.ts`, `adapter.ts`
- Modify: `test/v4/claude-command.test.ts`, `claude-parser.test.ts`, `claude-adapter.test.ts`
- Modify Claude fixtures

**RED tests:**

- Require a valid result envelope with success subtype and `is_error: false`.
- Reject unknown/prose/direct-outcome envelopes, invalid nested JSON, model-authored `native`, and invalid usage/cost values.
- Empty `writeTools` removes `workspace.write`; empty `shellPatterns` removes `shell`.
- `native-resume` requires successful `--resume` flag probe.
- Safe mode contains no dangerous flag; elevated mode contains it exactly once.

**Implementation:** use strict Zod native-envelope schemas and derive capabilities from tool policy plus successful help/fixture evidence.

**Official/local contract note:** current Anthropic CLI documentation and local `2.1.185 --help` both permit comma- or space-separated `--allowedTools` and expose `--resume`; keep argv tests exact so later CLI drift fails closed.

### R9 — Make Antigravity envelope, resume, and dual timeout strict

**Owner:** Antigravity adapter agent

**Depends on:** R6

**Files:**

- Modify: `src/v4/adapters/antigravity/command.ts`, `parser.ts`, `adapter.ts`
- Modify: `test/v4/antigravity-command.test.ts`, `antigravity-parser.test.ts`, `antigravity-adapter.test.ts`
- Modify Antigravity fixtures

**RED tests:**

- Strictly validate native result envelope and usage values.
- Require `printTimeoutMs < request.timeoutMs`, including when an option override is supplied.
- Resume uses the current proven `--conversation` path or fails closed and removes `native-resume`.
- Missing flags, workspace, or valid structured result are non-success.
- Safe/elevated modes and exact result correlation remain enforced.

**Implementation:** compute and validate native timeout once; never accept an override at or above the outer deadline. Do not infer resume/usage from general host behavior.

### R10 — Expand the shared adapter contract and P0 integration gate

**Owner:** integration/test agent

**Depends on:** R3-R9

**Files:**

- Modify: `src/v4/testing/adapter-contract.ts`
- Modify: `test/v4/adapter-contract.test.ts`
- Add/modify integration tests for all three adapters

**Required shared assertions, unchanged for every host:**

1. Probe shape, availability, signal forwarding, and conservative capabilities.
2. Safe argv has no elevated flag.
3. Explicit elevated mode contains the host's elevated flag exactly once.
4. Nonzero exit, timeout, abort, output-limit, spawn error, malformed native output, and malformed model output are non-success.
5. Model-authored `native` is rejected.
6. Valid model outcome plus strictly parsed native metadata passes `StepResultSchema`.
7. Execution ID correlation is exact.
8. Cancellation by operation ID is idempotent.
9. Unsupported resume fails closed and never starts a new session.

**P0 integration assertions for each production adapter with a fake runner:**

- Real `RunController`, `DefaultPolicy`, `FileEventStore`, and `FileArtifactStore` are used.
- Valid artifact/evidence advances exactly one phase.
- Prose/malformed/timeout/native spoof cannot transition.
- Retry bounds and protected-operation recovery cannot be bypassed.
- No provider-owned retry loop occurs.

**Acceptance:** `AdapterContractOptions.elevatedFlag` is actively asserted, and no host-specific weakening exists.

### R11 — Close compatibility evidence and documentation

**Owner:** release/evidence agent

**Depends on:** R10 and explicit user approval for model cost

**Files:**

- Modify: `test/v4/host-smoke.test.ts`
- Modify: `compatibility/v4/README.md`, `compatibility/v4/hosts.json`
- Modify: `ROADMAP_V4.md` only with measured evidence

**Non-cost work first:**

- Refactor smoke to use the real P0 controller and artifact store.
- Put all temporary cleanup in `finally`.
- Snapshot the temp repo before/after and assert only the intended workspace path changed.
- Verify safe argv, exit, strict native parse, `StepResultSchema`, checksum, exactly one phase transition, session ID, and available usage/cost.
- Add a per-host table: installed/verified version, required flags, contract command/result, smoke result or explicit absence, platform, current status, limitations.

**Cost gate:**

- Do not set `OMNI_V4_ALLOW_MODEL_COST=1` until the user explicitly approves the host and spend.
- Run one host at a time and record date, OS/platform, exact version, exact command, result, and artifact evidence.
- Set `contractVerified`, `liveSmokeVerified`, and `verifiedPlatforms` only when the exact host/version/platform passed both gates.
- A version change resets both booleans and the platform list.

**Acceptance:** usable but unevidenced hosts remain `experimental`; no JSON edit is treated as evidence.

## 7. Verification matrix

Run targeted tests during each card, then run this full gate after R10:

```powershell
npm audit --audit-level=high
npm run typecheck:v4
npm run build:v4
npm run test:v4
npm test
git diff --check
git diff --cached --check
rg -n "codex|claude|antigravity|agy" src/v4/core src/v4/policy src/v4/storage src/v4/contracts
rg -n "\bany\b|as any" src/v4/contracts src/v4/core src/v4/storage src/v4/process src/v4/compatibility
```

Expected:

- Every command exits `0`.
- v3 remains 976/976 passing or better; no v3 files changed.
- All new non-cost v4 tests pass.
- Only documented platform/live-cost tests may skip; no safety test is skipped.
- Vendor-name search returns no hits in core/policy/storage/contracts.
- `any` search returns no boundary/recovery escape hatch; any unavoidable internal occurrence is reviewed and documented.
- No diff whitespace errors.

## 8. Acceptance gates

### P0 exit gate

P0 may be accepted only when all are true:

- Replay rejects cross-run, missing-cause, wrong-cause, wrong-attempt, and false-transition logs.
- Two store instances cannot both append the same next sequence.
- Unavailable/incompatible adapter never starts.
- Controller deadline settles and cancels exactly once even when the adapter ignores the signal.
- Every documented crash cut-point has an exact, idempotent result.
- Protected operations are never replayed from missing/defaulted context.
- All P0 tests and the full v3 regression suite pass.

### P1 exit gate

P1 may be accepted only when all are true:

- Process runner proves child termination before returning timeout/abort/output-limit.
- Probe failures cannot become compatible or first-class.
- Capabilities are derived from current successful probes, strict parser fixtures, and active configuration.
- Native resume is functional and tested per host, or is omitted and fails closed.
- All native outputs are parsed through strict host schemas.
- One unchanged shared contract suite passes for all three hosts.
- Real-controller fake-runner integration passes for all hosts.
- Compatibility documentation states exact missing evidence.
- First-class promotion occurs only after approved, recorded live smoke evidence.

## 9. Migration and rollback

- V4 is not yet the package default; keep v3 untouched as the stable fallback.
- If R0 changes event/policy schemas, bump the v4 schema version or add an explicit migration reader. Never reinterpret old logs silently.
- Before schema migration, copy test fixtures and add backward-compatibility/rejection tests. Corrupt/ambiguous old logs must block with an actionable message.
- Each task should remain independently revertible by file ownership. Do not bundle P0 integrity fixes with host-specific P1 work.
- If a host cannot meet the shared contract, remove the unsupported capability and keep it experimental; do not weaken the common suite.
- If three fix attempts fail in one subsystem, stop and escalate the architectural decision instead of layering another patch.

## 10. Agent handoff template

Every coding agent returns this exact information:

```text
Task card: R<n>
Files changed:
Failing test added first:
Initial failure output:
Root cause fixed:
Targeted command and result:
Full v4 command and result:
Typecheck result:
Unresolved risks/dependencies:
Git status for owned files:
No commit/push/model-cost action performed: yes/no
```

Lead agent resumes by checking the task dependency, reading the owned diff, rerunning the targeted command, and only then advancing the graph.

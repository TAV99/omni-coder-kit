# S1 turn safety — Phase 2

Isolated authority executions enable turn supervision by default. Direct
`runIsolatedTask` callers opt in with `turnSafety: {}`; omission preserves the
legacy path. `turnSafety: false` explicitly disables supervision. Models, effort,
discussion protocol, server idle timeout and QC gates are unchanged.

Named defaults live in `lib/dual/turn-watchdog.js`: soft budget 10 minutes,
hard budget 20 minutes, heartbeat 60 seconds, no progress 5 minutes, nudge grace
2 minutes, polling 1 second. Each discussion setup, scout/review dispatch and
implement invocation has its own budget. Existing shorter provider timeouts
still apply. All thresholds and the clock are injectable for tests.

Progress is process stdout/stderr or changed workspace/artifact metadata
(runtime directory, allowed files and generated outputs; bounded traversal,
without following symlinks). Supervisor heartbeats never reset progress.
`last-activity.json` and append-only `turn-progress.ndjson` live beside the
attempt binding, outside the worker root. Events include phase, attempt,
elapsed time, last progress time, soft warning, heartbeat, one nudge and terminal
`STALLED`. These are supervisor diagnostics, not QC evidence. Aggregate terminal
events for phase time/stall count. Heartbeat proves supervisor liveness, not
worker progress. No checkpoint resume metric is inferred from these diagnostics.

Nudge is a persisted supervisor notification, optionally delivered once through
`onTurnNudge`; it does not inject a new provider message or change the discussion
protocol. Without a host callback it is visible through attempt telemetry only.
After the grace window, continued silence aborts the combined execution signal.
Hard budget aborts regardless of progress. The runner throws
`DUAL_TURN_STALLED`, with `status: STALLED`, reason, timing and workspace reference.
Authority records the existing schema's `FAILED` status with that specific code
and a `STALLED` summary. It settles the operation and releases the lease only
when child exit/close is proven; unresolved cleanup remains fail-closed. No
integration, automatic restart or kill-recovery classification occurs.

CLI abort uses existing process-tree termination and waits for close. Discussion
abort uses the existing child close/quiescence contract. Custom injected process
runners must honor `deps.signal` and settle after their children close.
Artifacts and partial workspace files are retained for explicit correction.

## Phase 2b: checkpoint and resume

A successful, contract-validated implement turn writes `checkpoint-N.json`
beside its attempt binding, outside the worker root. This happens after the
implement completion event, before scope/review; no streaming or partial-turn
checkpoint is taken. `N` is the implement turn attempt. Exclusive creation and
fsync make the manifest write-once (`DUAL_CHECKPOINT_EXISTS` on a second write).
`onCheckpoint({ path, sha256 })` gives authority the external hash anchor; it
must retain that reference rather than trust a manifest's own digest.

Manifest version 1 contains `phase`, `milestone: { summary, next }`, cumulative
`completedMilestones`, `sourceAttempt`, `sourceReference` (including binding
SHA-256), `originalBaseline`, and sorted `files` entries with path, SHA-256,
size and mode. `checkpointMilestone: { summary, next }` supplies the authority's
milestone description; omission records completion of the task's implement
turn. Files cover the source workspace, including generated outputs, excluding
the task runtime and declared private dependencies. Runtime artifacts are
regenerated; dependencies retain their existing independent verification.

`resumeIsolatedTask({ ...runOptions, sourceReference, checkpoint, attempt })`
is an explicit authority API, requiring live `authorize`, the same session,
task and plan revision, and a newer attempt number. Authority must own the new
attempt's lease/operation as for `runIsolatedTask`; this primitive does not
schedule or integrate work. It requires the latest checkpoint reference,
validates its hash, source binding, original baseline/contract and exact
preserved source file set before creating an exclusive new attempt. Workspace
or manifest modification is `DUAL_CHECKPOINT_TAMPERED`; invalid resume selection
is `DUAL_CHECKPOINT_INVALID`. Validation never silently falls back to retry.

The new binding retains original `sourceFiles` and `snapshotSha256`, so result
collection and integration measure all milestone changes against the original
source. `worker-baseline.json` and its SHA-256/identity remain identical to the
original, with `originalBaseline: { path, sha256 }` retaining the source reference.
Binding-owned `resumeLineage` and `resume-lineage.json` record checkpoint path/hash,
source attempt/binding, new attempt, original baseline and milestone handoff.
The implement prompt receives cumulative completed summaries and the next
milestone instruction, with an instruction to preserve completed work.

Only the clean-start workspace comparison uses a separate, immutable
`resume-workspace-baseline.json`, hash-bound in lineage and guarded during
execution. It must match the validated resumed workspace exactly. Task/artifact
correlation, scope, review fingerprints and QC/integration continue to use the
original baseline. No gate accepts arbitrary pre-existing changes.

Without a checkpoint, explicit resume is a baseline retry: original files are
restored from the hash-anchored `original-workspace.json` captured before the
first turn, discarding incomplete worker output. Lineage records
`mode: baseline-retry` and `resumedFrom: null`; no milestone completion is claimed.
An existing checkpoint must be named explicitly. Old attempts lacking these
original-workspace references cannot use this API.

Watchdog budgets, abort/quiescence and `DUAL_TURN_STALLED` behavior are unchanged.
A later stalled turn leaves the last completed checkpoint available. Resume
requires that the preserved source still matches it: later partial source
changes are rejected, not rolled back silently. There is no automatic resume,
provider protocol change, or QC approval implied by checkpoint completion.

Focused verification uses `node --test --test-isolation=none` in this sandbox
(the default isolated test launcher can hang). See the final implementation
report for results and sandbox failures; coordinator should rerun at top level.

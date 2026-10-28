# S1 turn safety — Phase 2a

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
worker progress. No checkpoint resume metric is claimed in 2a.

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

## Phase 2b: checkpoint and resume (deferred explicitly)

2a does not implement checkpoint-based resume. Existing immutable worker handoff
and attempt workspace preservation remain available; they are not advertised as
milestone checkpoints. Current binding, worker baseline, contract and QC
correlation assume the initial workspace. Copying partial output into a new
attempt without changing that lineage would either invalidate verification or
hide changes from integration.

2b should persist an immutable checkpoint manifest at each completed turn:
source attempt/binding hash, completed phase/milestone summary, workspace file
hashes and a handoff to the next milestone. Explicit resume validates those
hashes, creates a new attempt from the preserved workspace, retains the original
source baseline for integration/QC, and passes the completed-milestone summary
to the worker. This needs authority-owned lineage and tamper/correlation tests,
plus a resume-to-final-artifact trial. It is separated to avoid expanding 2a into
a baseline/contract migration while implementing cancellation safety.

Focused verification uses `node --test --test-isolation=none` in this sandbox
(the default isolated test launcher can hang). See the final implementation
report for results and sandbox failures; coordinator should rerun at top level.

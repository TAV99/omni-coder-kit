# Customer specification — verbatim

## Yêu cầu người dùng

tiếp tục astra viết spec và plan theo kết quả đã thống nhất. Argon review, sửa nếu cần. Sau khi đã chốt spec/plan. Argon trực tiếp sửa code

## Approved shared proposal v1 — verbatim

FINAL SHARED PROPOSAL v1 (a proposed implementation plan, NOT implemented):
1. Goal: improve question/reply continuity and traceability, not claim speed/reliability improvement yet. Omni controller owns relay; agents never recursively invoke each other's CLI. CLI conversation ID is not authority.
2. Add an opt-in discussion adapter and feature flag default OFF. Phase 1 only read-only analysis using bounded source snapshots in a separate sandbox. A temporary directory or plan flag alone is NOT a security boundary; verify permissions/tool restrictions. No project edits, no issuing/revoking/extending execution leases, no changes to isolated-runner flag guards in MVP.
3. Versioned conversation binding: provider, model/effort, conversation_id, role, Dual session_id, task_id, plan_revision, plus existing attempt/workspace-binding hash when applicable. No fabricated attempt for chat. Changed revision/task/attempt/workspace binding invalidates reuse; retain old transcript and create new conversation only when safe and authorized, passing scoped reviewed summary. Never delete old session on timeout.
4. Versioned envelope: message_id, binding_ref, sequence, reply_to, payload_hash, expiry; bounded text. Controller-owned durable delivery journal/outbox, idempotent record receipt, one in-flight invocation per conversation and single dispatch ownership. No exactly-once provider guarantee.
5. Keep four separate statuses: stored receipt ACK; provider invocation success (exit status + explicit provider-specific positive completion allowlist, not merely status != error); schema-valid payload; authority task acceptance. Stale/failed output may be retained for diagnosis but cannot advance task state. Chat DONE never completes tasks.
6. Before dispatch and before accepting result into a task, validate current authority/binding. Unknown timeout/crash -> outcome_unknown and block dispatch for that binding. Reconcile OS process AND provider outcome; process exit alone is not enough. If provider cannot establish outcome, fail closed and require authorized recovery. No blind provider retry, no auto new attempt, no blanket lease revocation in discussion MVP.
7. G0 deterministic contract/adapter tests: stale binding, duplicate/conflict/reply correlation, concurrent resume/ownership, malformed output, error envelope with valid payload, explicit success checks. G1 real two-way read-only continuity and model binding smoke. G2 injected faults/restart at delivery boundaries, bounded loops, unknown outcome, orphan/process/provider reconciliation. No duplicate dispatch in tested cases. Report observed evidence, not universal guarantees.
8. Compare cold-start vs resume on same bounded tasks/models: answer continuity/quality, p50/p95 wall time, token/cost when observable, completion rate, duplicate dispatch, manual recovery count. Select target thresholds and sample size before running; no preset percentage claims unsupported by measurements.
9. Only after G0-G2 evidence and explicit approval, design isolated coding integration as a separate phase preserving leases, baseline/artifact validation, QC and integration gates. Keep current path unchanged when flag OFF; rollback by disabling new dispatch and reconciling outstanding turns, not blindly restarting old workflow.
Implementation order: contract/tests -> isolated read-only adapters -> controller journal/dispatch/reconciliation -> real smoke/fault suite and benchmark -> approval decision for coding. Suggested integration points from supplied snippets are agy-output parsing, task-messages correlation, and a new discussion adapter; full repo inspection is required before selecting exact files/API signatures.


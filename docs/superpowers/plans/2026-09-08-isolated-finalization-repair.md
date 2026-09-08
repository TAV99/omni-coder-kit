# Isolated worker finalization — Implementation Plan

> **For agentic workers:** Use subagent-driven-development and TDD. Coding implementer: Luna/xhigh; controller owns review and independent checks. No commit/push.

**Goal:** Không để worker đã kết thúc rơi vào trạng thái không outcome/handoff và lease không release khi validation/collection lỗi hoặc lease expiry.

**Architecture:** Phân biệt private phase completion với authority handoff/QC. Resource/scope validation phải fail sớm, có bounds, không bỏ qua dependencies/build output chưa được cấp quyền. Thêm đường ghi nhận thất bại/finalization có lineage và process evidence, không cho expired lease ghi success hoặc nâng quyền source.

**Tech Stack:** Existing Node CommonJS, node:test, durable authority events and private snapshot contracts; no new dependency.

## Global Constraints

- Base:5ea455f on existing codex/v3.1.2. Preserve package.json/package-lock version bump; no stage/commit/push.
- E:\LdPage and every original/archived ledger, worker workspace, .git lock, config and daemon remain read-only. Do not resume/recover/kill/start/restart customer processes or call AGY/model for validation.
- Do not weaken allowed_files, deny_patterns, snapshot fingerprints, dependency receipts, Codex QC, attempt budget, or process-tree safety. exit0/private CODEX_QC is not authority success.
- No automatic archive/new-session/attempt4 to evade budget. No arbitrary timeout/TTL increase as the fix.
- One Luna coding subagent, no nested agents. Parent may use read-only reviewer. Tests disposable fixtures only, bounded durations and guaranteed cleanup.

### Task 1: Reproduce and close post-worker finalization gap

**Files allowed:** lib/dual/isolated-authority.js, lib/dual/task-processes.js, lib/dual/task-workspace.js, lib/dual/isolated-runner.js, lib/dual/authority-store.js, lib/dual/contracts.js; lib/dual/daemon-server.js and lib/commands/dual.js only for bounded status/diagnostic propagation if needed; test/dual-isolated-runner.test.js, test/dual-task-processes.test.js, test/dual-task-workspace.test.js, test/dual-authority-store.test.js and new test/dual-finalization.test.js. Workflow docs templates/workflows/dual-controller.md and task-planning.md. Ask before expanding scope.

**Evidence:** Session df01ed59-297e-4a5d-ad8d-fbe666fd795a last process exit0 at18:23:58.006Z; private review completed and handoff.completed at18:23:58.147Z; private state CODEX_QC, evidence SUCCESS/unverified_items[], review APPROVE; no worker-handoff.json at outer attempt root. Lease renewed18:23:51, expires18:24:21, never released. Foundation writes package/lock, dependency mode absent, validators npm typecheck/lint. This points to outer validation/collection but does not prove exact throw or controller death.

- [ ] RED fake-clock fixture: tracked children close normally, private run reaches final validation, clock crosses expiry and validation throws. Assert durable FAILED outcome/diagnostic and deterministic terminal lease state, not silent ROUTED orphan. Existing code only records failure for active lease and releaseLease rejects expired lease: demonstrate with exact test output.
- [ ] RED collection fixture with unmanaged node_modules and build artifact: verify bounded failure before recursive dependency scanning, no copying unwanted files, no silently ignoring unverified dependency content. Scope violation remains enforced for dist unless explicitly supported by contract.
- [ ] GREEN implement minimal early checks in collectTaskResult/scan. For task without approved dependency mode, presence of node_modules must return explicit setup/contract error promptly, not deeply hash it. Managed npm-ci still verifies receipt and skips only its managed dependency tree. Do not treat missing receipt as success or exempt dist globally.
- [ ] GREEN preserve original finalization error even if cleanup errors. Record failure with stage/code and safe bounded diagnostic; no raw stdout/credentials or absolute private content dumps. Catch must not skip outcome simply because lease expired.
- [ ] If a new event is necessary, add narrowly typed finalization-failed event bound to session/revision/task/attempt/lease/controller execution. Replay validates unreleased matching lease, task unverified, no conflicting handoff/terminal record. It may record failure after expiry; it MUST NOT authorize success/source writes or resurrect/extend lease. Design idempotence using exact existing event lineage, no caller-fabricated PID death.
- [ ] Release after expiry only through a narrowly validated settlement path with evidence of normal close for all tracked children, no pending spawn, correct controller execution and same lease; retain conservative process-tree recovery for unknown/dead/detached children. If safe release cannot be proven, expose explicit NEEDS_PROCESS_* recovery plus durable failure, not silent hanging. Never remove the existing general expired release guard.
- [ ] Tests for active success, active validation failure, expired all-closed failure, expired pending/running child, delayed close, stale attempt/revision, replay/idempotence, duplicate finalization, corrupt artifact, cleanup throw preserving original cause. No success receipt on any failure.
- [ ] Optional observable stage markers should be minimal and durable only when necessary; do not add a generic job framework. Distinguish phase.started/completed vs post-worker collection vs outer handoff in bounded status/errors.
- [ ] Workflow fixes: dependency install belongs to typed setup + immutable package/lock npm-ci when validators need installed tools; do not assign package/lock writes and managed npm-ci in same immutable slice. Keep build output handling explicit. Show correct existing task-level recovery versus archive --if-pristine, no advice to bypass guards.
- [ ] Run focused tests, record RED/GREEN and self-review. Return report `.omni/runs/finalization-repair/luna-report.md` with changed files, exact commands/results, proven cause versus hypotheses, and safety limits.

## Controller acceptance

- [ ] Review all code and evidence; challenge bypasses and missing real behaviors. Independent reviewer spec + quality gate; Luna fixes concrete findings.
- [ ] Fresh focused and full suite after freeze; syntax/diff checks. Old test counts do not qualify new code.
- [ ] Report implemented vs verified vs live recovery. No customer process actions or paid run in this task.

## Status

Implementation and verification complete locally. Luna/xhigh reproduced the expired-lease failure masking gap, implemented typed failure-only settlement and bounded unmanaged dependency rejection, and corrected reviewer findings on owner/revision/superseding execution and historical correction/context resume. Primary finalization15/15 pass; reviewer v3 APPROVED; full suite1766pass/0fail/2skip (1768 tests), exit0. See ISOLATED_FINALIZATION_FIX_REPORT.md. Exact historical customer throw remains unproven; no live recovery or customer mutation, no commit/push.

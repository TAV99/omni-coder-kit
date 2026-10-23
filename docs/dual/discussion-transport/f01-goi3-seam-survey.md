# F01 — Gói 3a: seam thực thi phase

Khảo sát ngày 2026-10-23. Gói này chỉ thêm bridge và test, chưa nối route vào engine.

## Call chain hiện tại

- CLI: `lib/commands/dual.js:281` (`getOrchestrator`) → `:402` (`orch.runPhase`).
- MCP/daemon: `lib/dual/mcp-server.mjs:819` (`client.beginSession`), `:894`
  (`plan.register`), `:1163` (`session.resume`) → daemon điều phối task;
  `lib/dual/daemon-server.js:543` tạo `createOrchestratorAdapter`, `:2681` gọi
  `effectiveOrchestrator.runTask` → `lib/dual/orchestrator-adapter.js:59` (`runTask`)
  → `:71` (`executeAgyTask`) → `:246` tạo orchestrator → `:376` (`taskOrchestrator.run`).
  Nhánh isolated tại `orchestrator-adapter.js:73` →
  `lib/dual/isolated-authority.js:167` (`runIsolatedTask`) →
  `lib/dual/isolated-runner.js:134` tạo orchestrator, `:159`–`:160` chạy preflight/scout,
  `:194` chạy phần còn lại bằng `orchestrator.run`.
- `lib/dual/orchestrator.js:1699` (`run`) chọn phase → `:998` (`runPhase`).
  Scout dựng input/schema tại `:1212`–`:1218`, gọi `executeAgyWithRetry` tại `:1220`;
  implement gọi tại `:1482`; review dựng input/schema tại `:1635`–`:1643`, gọi tại `:1645`.
- `lib/dual/orchestrator.js:715` (`executeAgyWithRetry`) là caller duy nhất trong
  production của `buildAgyInvocation` (`:771`). Builder ở `lib/dual/agy-runner.js:27`
  chọn `accept-edits` cho implement, `plan` cho phase khác, truyền schema/model/effort.
  `orchestrator.js:787` gọi injected `processRunner` (default `runProcess` tại `:485`);
  `agy-runner.js:133`–`:151` thực sự `child_process.spawn`, thu stdout/stderr,
  timeout và terminate process tree. Builder không chạy process.
- `orchestrator.js:833`–`:835` lưu raw evidence; `:860` gọi
  `lib/dual/agy-output.js:40` (`extractAgyPayload`): kiểm exit/output, parse outer JSON,
  ưu tiên `structured_output`, fallback `response` JSON hoặc fenced JSON;
  `agy-output.js:24` gọi `parseContract(schema, candidate)`. Correlation với baseline/task
  còn được kiểm ở recovery (`orchestrator.js:916`–`:920`) và adapter đọc artifact
  (`orchestrator-adapter.js:380` trở đi).

## Result và chủ sở hữu state

`executeAgyWithRetry` trả `{ extracted, result, meta, attempt }` (`orchestrator.js:861`):
`extracted = { payload, extractionMode, warnings }` (`agy-output.js:79`), `result` là
process observation (`exitCode, stdout, stderr, timedOut, startedAt, endedAt, durationMs`),
`meta` là attempt evidence. `runPhase` ghi `extracted.payload` vào artifact, rồi trả
`{ taskId, state, owner, nextAction, warnings, reused }` cho caller.

Payload là object theo `lib/dual/contracts.js:64` (`createCorrelatedSchema`):
`schema_version: 1`, `task_id`, và `expected_base_commit` hoặc `expected_baseline`.
Scout dùng `ContextSchema` (`:177`: summary, relevant_files, exact_symbols,
validation_commands, constraints, risks, open_questions, research_trace,
alternatives_considered, failure_modes); implement dùng `EvidenceSchema` (`:228`);
review dùng `ReviewSchema` (`:243`: recommendation, risk_level, findings,
review_checks, challenge_summary). Schema kiểm cardinality và field types.

**Không có worker phase `plan` hôm nay:** `PhaseSchema` (`contracts.js:35`) là
preflight/scout/spec/route/implement/scope/review. `spec` đọc spec do controller cung cấp,
`route` định tuyến; plan manifest được đăng ký qua authority, không gọi AGY phase `plan`.
Gói 3b phải quyết định mapping plan và schema; không được giả định đã có `PlanSchema`.
Bridge Gói 3a chỉ parse JSON object (kể cả surrounding fence), chưa thay validation nghiệp vụ.

Orchestrator sở hữu việc append `phase.started/failed/completed`, ghi artifact và handoff
(`:784`, `:1234`–`:1243`, `:1668`–`:1684`). `lib/dual/state-store.js:42` định nghĩa
phase transitions, `:104` replay, `:274` append/validate/hash evidence, `:317` derive current.
Authority ledger/lease vẫn thuộc daemon; journal chỉ sở hữu trạng thái hội thoại.

## Branch point nhỏ nhất cho Gói 3b

Chọn `lib/dual/orchestrator.js`, **`executeAgyWithRetry`**, ngay trước retry loop
(`:761`–`:771`), sau capability/registered-task checks. Branch có guard opt-in và
allowlist discussion; chỉ scout/review đang đi tới seam này. Implement giữ đường cũ.
Nhánh mới gọi bridge một lần, validate `result` bằng `schema` hiện tại, tạo cùng shape
`{ extracted, result, meta, attempt }` và ghi raw evidence tương thích recovery.
Giữ nguyên caller: baseline checks, review diff guard, artifact hashes và state transitions.
Không đặt discussion dispatch trong retry loop: `OUTCOME_UNKNOWN` phải dừng, mang invocation
evidence về host; không chuyển sang cold-start fallback hay auto-retry.

Host tạo/cache `createDiscussionSession` (`lib/dual/discussion/session.js:35`) theo dual
session, cung cấp host ports và conversation IDs đã seed; inject session hoặc resolver vào
orchestrator. Cache relay theo `(sessionId, taskId, planRevision, snapshotSha256, execution)`
vì bindings bất biến (`session.js:13`–`:32`); dùng lại qua scout/plan/review khi identity khớp.
Task/revision/snapshot/execution đổi cần binding/relay mới và stateDir riêng; giữ journal cũ.
Một cặp conversation IDs có thể dùng lại trong cùng dual session, không seed mỗi phase;
đừng cache chỉ bằng sessionId rồi dùng binding của task cũ. Lifecycle do host quản lý,
không close sau mỗi phase; unknown cần evidence/reconcile trước khi close.
Caller chọn direction bằng `bindingRef(session.bindings[...])`; bridge chuyển nguyên refs
cho `relay.receive`, nơi `validateEnvelope` kiểm membership/choreography (`relay.js:344`).
Sequence lấy `inspect().messages.length + 1` như harness (`test/dual-discussion-live.test.js:115`).

## Config đang có

- `lib/commands/dual.js:281`–`:312`: env `OMNI_DUAL_AGY_COMMAND`,
  `OMNI_DUAL_AGY_PREFIX_ARGS` (JSON hoặc single arg), `OMNI_DUAL_FAKE_AGY`; overrides
  được truyền vào `createDualOrchestrator`.
- `lib/dual/orchestrator.js:478`–`:498`: options command/prefix/processRunner/env/timeout,
  `options.env || process.env`, worker model/effort resolver.
- `lib/dual/agy-model.js:21`–`:53`, `:56`–`:88`: options →
  `OMNI_DUAL_WORKER_MODEL`/`OMNI_DUAL_WORKER_EFFORT` → `.omni/manifest.json`
  (`workerModel`/`workerEffort`, bounded JSON read) → defaults.
- `dual.discussion.enabled` mới là đề xuất trong F01 integration design, chưa được engine
  đọc. `session.js:36` chỉ bật khi `options.enabled === true`; default disabled.
  Gói 3b nên resolve flag một lần ở host rồi inject, giữ kiểu boolean nghiêm ngặt.

## Regression gate Gói 3b

Chạy toàn bộ `test/dual-*.test.js`: ngoài discussion còn có orchestrator/AGY schema,
daemon/MCP/CLI, authority/lease, recovery, isolated workspace, snapshots/baseline,
scope/security, scheduler/process lifecycle, QC/acceptance/completion. Danh sách file
hiện có dưới đây là gate bảo thủ để tránh sót suite. Live discussion suites opt-in bằng
`OMNI_DUAL_LIVE=1`; benchmark `test/dual-discussion-live-benchmark.js` chạy riêng,
không thuộc offline unit gate.

```text
test/dual-acceptance-correction.test.js
test/dual-acceptance-integration.test.js
test/dual-acceptance-policy.test.js
test/dual-adversarial-review-2.test.js
test/dual-agy-runner.test.js
test/dual-agy-schema-boundary.test.js
test/dual-authority-cli-routing.test.js
test/dual-authority-store.test.js
test/dual-baseline-git.test.js
test/dual-baseline-snapshot.test.js
test/dual-bootstrap.test.js
test/dual-capability-preflight.test.js
test/dual-cli.test.js
test/dual-contracts.test.js
test/dual-controller-workflows.test.js
test/dual-custom-model.test.js
test/dual-daemon-cli.test.js
test/dual-daemon-client.test.js
test/dual-daemon-contracts.test.js
test/dual-daemon-lifecycle.test.js
test/dual-daemon-orchestrator.test.js
test/dual-discussion-adapter.test.js
test/dual-discussion-contracts.test.js
test/dual-discussion-daemon-ports.test.js
test/dual-discussion-host-session.test.js
test/dual-discussion-journal.test.js
test/dual-discussion-live-g2.test.js
test/dual-discussion-live.test.js
test/dual-discussion-phase-bridge.test.js
test/dual-discussion-recovery.test.js
test/dual-discussion-relay.test.js
test/dual-durable-failures.test.js
test/dual-e2e.test.js
test/dual-external-operations.test.js
test/dual-finalization.test.js
test/dual-flow-checkpoints.test.js
test/dual-flow-friction.test.js
test/dual-flow-mcp.test.js
test/dual-flow-plan-policy.test.js
test/dual-flow-preflight-retry.test.js
test/dual-flow-quality-replay.test.js
test/dual-flow-responsiveness.test.js
test/dual-flow-rpc-budget.test.js
test/dual-git-drift-verification.test.js
test/dual-handoff-rejection-transport.test.js
test/dual-handoff-rejection.test.js
test/dual-hook-bridge.test.js
test/dual-incident-dependencies.test.js
test/dual-incident-routing.test.js
test/dual-isolated-runner.test.js
test/dual-manifest-integrity.test.js
test/dual-mcp-server.test.js
test/dual-observer-preflight.test.js
test/dual-operation-lifecycle.test.js
test/dual-orchestrator.test.js
test/dual-plan-template-schema.test.js
test/dual-private-dependencies.test.js
test/dual-qc-progression.test.js
test/dual-quality-ledger.test.js
test/dual-root-fix-a-c.test.js
test/dual-setup-cli.test.js
test/dual-setup-runner.test.js
test/dual-skill-selector.test.js
test/dual-snapshot-policy.test.js
test/dual-snapshot-store.test.js
test/dual-state-store.test.js
test/dual-task-integration.test.js
test/dual-task-processes.test.js
test/dual-task-scheduler.test.js
test/dual-task-workspace.test.js
test/dual-trust-e2e.test.js
test/dual-ui-gate.test.js
test/dual-validator-lifecycle.test.js
test/dual-validator-process.test.js
test/dual-validator-security.test.js
test/dual-visual-qa.test.js
test/dual-workspace.test.js
```

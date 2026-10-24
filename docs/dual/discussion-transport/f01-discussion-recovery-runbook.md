# F01 Phase 3 — Runbook khôi phục discussion theo journal

Ngày đối chiếu source: 2026-10-24. Áp dụng cho `scout`/`review` discussion-only;
`implement` vẫn dùng process. Đây là hướng dẫn tìm evidence, kiểm tra read-only và giới hạn
reconcile trong owner đang sống; chưa phải workflow resume end-to-end sau restart.
Xem [khảo sát retirement §5](f01-phase3-retirement-survey.md#5-tài-liệu-và-runbook-cần-xử-lý).

## 1. Dừng dispatch và tìm evidence

Khi gặp `OUTCOME_UNKNOWN`, dừng AUTO/dispatch tiếp cho hội thoại bị khóa. Không blind retry,
không chuyển sang cold provider, không tự reset session hoặc đổi task/baseline/revision/key
để né unknown. Flag off không phải rollback transport trong Phase 3: scout/review fail-closed
(`DUAL_DISCUSSION_REQUIRED` và các mã precondition liên quan khi thiếu discussion/resolver).

1. Xác định workspace/task run directory (shared thường là
   `.omni/codex-gemini/runs/<taskId>`; isolated phải tìm trong private attempt tương ứng).
   Đọc `raw/<phase>.<attempt>.meta.json` nếu có: `transport`, `messageId`,
   `responseMessageId`, task/baseline và attempt. Meta thành công có thể chưa tồn tại khi
   dispatch lỗi; không coi thiếu meta là chưa gọi provider.
2. Đọc `raw/<phase>.<attempt>.failure.json`, failure excerpt/issues và task events
   `phase.failed`. Giữ error code, recoveryError hoặc recoveryOutcome nếu có. Failure artifact
   hiện không lưu message/invocation/binding IDs; lấy các refs này từ meta nếu có, error
   details còn trong owner hoặc relay/journal inspection, không bịa refs khi thiếu evidence.
   Đối chiếu session/task/plan revision, lease/operation với authority;
   không suy trạng thái authority từ journal một mình.
3. Daemon đặt discussion state root tại `.omni/runs/dual-discussion` trong workspace.
   Shared resolver dùng thư mục con `encodeURIComponent(cacheKey)` với
   `cacheKey = taskId + '|' + workspaceBaselineId + '|' + planRevision`.
   Tên tham số resolver là `snapshotSha256`, nhưng giá trị này là **workspace baseline id/hash**.
   Binding `snapshot_sha256` là SHA-256 của **snapshot text hội thoại** chứa session/task,
   objective, `workspace_baseline_id` và revision; hai hash có vai trò khác nhau,
   không thay thế nhau khi đối chiếu evidence.
4. Isolated child dùng `.omni/runs/dual-discussion/isolated/<executionKey>` ở state root
   của host. `executionKey` hash identity private execution (session/task/revision,
   canonical worker root, attempt, reference binding hash, worker baseline, operation).
   Đối chiếu private attempt/reference và bindings thật; không tìm theo shared cache key
   hoặc mở resolver source workspace để thay child.

Giữ evidence gốc và đường dẫn, timestamp, revision chạy. Khi chuyển evidence cho điều phối,
chỉ trích đoạn cần thiết, tránh phát tán prompt/provider output nhạy cảm.

## 2. Chẩn đoán read-only

API trong `lib/dual/discussion/journal.js`:

```js
const { inspectJournal } = require('./lib/dual/discussion/journal');
const view = await inspectJournal({ stateDir }); // thư mục journal cụ thể, không phải state root
```

Đây là API snippet trong Node context có async, không phải lệnh resume. API kiểm tra path,
file, quotas, lock metadata và hash-chain; trả `locked`, `owner`, `events`,
`unresolvedInvocations`, `hasUnresolvedUnknown`. Path chưa tồn tại trả view rỗng,
không chứng minh provider chưa được gọi: trước hết kiểm đúng namespace.

Nếu còn handle relay trong owner đang sống, `await relay.inspect()` trả `closed`, `blocked`,
`unknown`, `bindings`, `snapshot_sha256`, `messages`, `turns`, `invocation_count`.
Đối chiếu `unknown.message_id`, `invocation_id`, `binding_ref` với failure evidence.
Inspect không tự phục hồi hoặc mở khóa. Không sửa journal/hash-chain hay lock thủ công,
không xóa owner lock, không mở thêm writer để “thử lại”. Nếu inspection báo integrity/path
error, dừng và chuyển evidence cho điều phối.

## 3. Reconcile chỉ với owner relay còn sống

API `await relay.reconcile(messageId, evidence)` chỉ áp dụng khi relay vẫn mở, còn unknown
cho đúng message và **không có active invocation** (`OWNER_BUSY` nếu còn invocation).
Không dùng `close()` như cách giải phóng unknown trước reconcile.

Relay kiểm authority ở stage `recovery` và gọi host `capabilityVerifier.verifyRecovery`.
Caller không tự khai terminal rồi coi đó là proof. Evidence được host xác minh phải có:

- `allowed === true`, `processQuiescent === true`, `providerTerminal === true`;
- `providerOutcome` là `succeeded` hoặc `failed`, không phải `unknown`;
- `evidenceId` không rỗng; `bindingRef` và `invocationId` khớp unknown invocation.

Host mặc định lấy recovery probes từ chính adapter instances đã chạy turns; isolated child
còn phải giữ đúng execution/authority/guards. `{}` truyền vào reconcile có thể để host tự
probe; nó không bảo đảm probe sẽ có proof. Authority stale, adapter mất bookkeeping hoặc
proof thiếu/không khớp → giữ blocked, dừng và escalate. Chỉ sau proof hợp lệ relay mới append
`reconciled`, ghi outcome và xóa unknown để unblock relay.

Bridge có **tối đa một recovery budget** dùng chung cho settled-failed retry và unknown
reconcile. Chỉ re-ask khi lần trước settled failed hoặc reconciled failed. Schema correction
một lần là cơ chế riêng, không cấp thêm recovery budget. Reconciled succeeded không tự biến
late output thành phase artifact: bridge vẫn ném lỗi kèm `recoveryOutcome: 'succeeded'`;
không copy output muộn thành context/review JSON hay tự append phase completion.

## 4. Điểm dừng và escalation

Unknown tại orchestrator ghi `phase.failed` với `retryable: false`. Lần `runPhase` tiếp theo
thấy terminal failure sẽ throw và chặn AUTO. Reconcile relay **không tự xóa `phase.failed`**;
relay unblocked không đồng nghĩa task phase có thể tiếp tục. Không sửa task events/artifacts
để ép chạy lại.

`relay.close()` khi unknown sẽ đóng relay nhưng **giữ lock** và throw `OUTCOME_UNKNOWN`;
close không phải reset/recovery. Host cache/registry và adapter bookkeeping chỉ trong bộ nhớ;
journal bền không tự tái tạo owner/adapters sau restart. **CHƯA có workflow đã xác minh
restart → reclaim owner → tiếp tục terminal phase**, cũng chưa có lệnh CLI/RPC resume/reconcile
end-to-end được runbook này chứng nhận.

Dừng tại các trường hợp owner mất/đã đóng, invocation còn active, authority stale, proof
không đủ, integrity lỗi hoặc phase đã terminal failed (kể cả relay reconcile thành công).
Chuyển cho Muse/điều phối: revision/version, workspace và private attempt nếu có,
session/task/revision/baseline, lease/operation, meta/failure paths và excerpt/issues,
journal path + inspection/owner/lock state, message/invocation/binding refs, probe/reconcile
kết quả thật. Giữ nguyên evidence/lock; quyết định phục hồi tiếp cần workflow riêng được kiểm
chứng, không tự đổi key hoặc start new session để né unknown.

`pending_questions`/`context_reply`, task correction và QC vẫn thuộc authority workflow
trong [README](../../../README.md). [Runbook async validator](../../dual-safe-recovery.md)
chỉ áp dụng validator quality/acceptance-correction; hướng dẫn “start new session” ở đó
không phải cách chữa unknown discussion.

## 5. Benchmark lịch sử

OLD của `test/dual-phase2-benchmark.js` đã retire ở Phase 3, kể cả default pair OLD/NEW.
Tái lập OLD cần checkout revision lịch sử trong workspace riêng có nhãn version;
không có hidden cold option trong sản phẩm. NEW vẫn có live gate và cần `--modes=NEW`;
không dùng kết quả NEW so với OLD fail-closed để tuyên bố tăng tốc. Protocol/số đo Phase 2
được giữ tại [protocol](f01-phase2-benchmark-protocol.md) và [report](f01-phase2-benchmark-report.md).

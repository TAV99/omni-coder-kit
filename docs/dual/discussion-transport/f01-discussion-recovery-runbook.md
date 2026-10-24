# F01 Phase 3 — Runbook khôi phục discussion theo journal

Ngày đối chiếu source: 2026-10-24. Áp dụng cho `scout`/`review` discussion-only;
`implement` vẫn dùng process. Đây là hướng dẫn tìm evidence, kiểm tra read-only và giới hạn
reconcile trong owner đang sống và recovery SHARED tường minh sau restart toàn bộ.
Live proof phải được chạy ở shell cấp cao nhất; không suy kết quả live từ test offline.
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
   `cacheKey = taskId + '|' + workspaceBaselineId + '|' + planRevision + '|' + workerModel + '|' + workerEffort`.
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

### 4.1 SHARED: restart toàn bộ và recovery tường minh

Phạm vi kiểm chứng của 3.1.2 là **daemon + toàn bộ cây workers đều chết** (tương đương
VM restart). Daemon chết riêng nhưng detached workers/orphans còn sống nằm ngoài phạm vi
chứng minh. Không dùng workflow này để suy rằng workers còn sống đã quiescent.

1. Giữ workspace, session/task/baseline/revision/model/effort và journal directory gốc.
   Lưu inspection, task phase events và owner metadata trước khi thao tác.
2. Xác minh daemon cũ và workers đã chết. Chờ thật **hơn 5 phút** sau crash; reclaim kiểm
   `Date.now() - owner.lock.mtimeMs > 300000` và chỉ nhận PID chết với `ESRCH`.
   PID sống, `EPERM`, PID/token không hợp lệ hoặc lock mới hơn ngưỡng đều giữ `OWNER_BUSY`.
   Không sửa mtime, PID, token hoặc hạ ngưỡng. Lease shared có TTL mặc định 30s + heartbeat;
   lease active chặn acquire, expired được tính từ expires_at và acquire mới được phép.
   Luật lease không thay đổi (test phủ ở `test/dual-authority-store.test.js`).
3. Khởi động executable daemon với cùng workspace và flag chỉ dùng cho recovery:
   `OMNI_DUAL_DISCUSSION_RECLAIM_STALE_OWNER=1` (các cấu hình model/effort giữ nguyên).
   Gọi `client.resumeSession(sessionId)` theo daemon-client hiện có. Startup bình thường
   không có flag không reclaim. Library dùng `createDiscussionHost({ reclaimStaleOwner: true, ... })`
   hoặc `createDiscussionSession({ reclaimStaleOwner: true, ... })` cho đường shared.
4. Reclaim validate journal bằng parser/caps/hash-chain hiện có trước khi đổi tên lock.
   Archive `owner.lock.reclaimed.<timestamp>.<oldToken8>` giữ nguyên metadata owner cũ,
   rename được directory-fsync: đây là audit trail bền, giữ vô thời hạn. Lock mới vẫn
   tạo bằng `wx` và token mới. Guard `owner.lock.reclaiming` serialize reclaimers;
   nếu crash ngay trong reclaim để lại guard, giữ fail-closed và chuyển evidence cho điều phối,
   không tự xóa guard để thử lại. Journal hỏng giữ `JOURNAL_INVALID`, không archive/reclaim.
5. Session đọc conversation IDs từ `registered`, dựng bindings bằng đúng snapshot text và
   model/effort resolution cũ. Relay kiểm exact registration equality; mismatch fail-closed.
   Không seed lại, không append `registered` lần hai. Replay hydrate messages, turns,
   invocation_count, evidence và unknown từ `received`/`dispatch_intent`/`observation`/
   `response`/`outcome_unknown`/`reconciled`. Queue, promises và active invocation handles
   khởi tạo mới; intent chưa có terminal response trở thành unknown, không dispatch lại.
6. Trên đường `session.resume` tường minh, daemon truyền `{ resume: true }` theo task
   đến adapter. Sau khi lấy lease và validate run correlation, trước `taskOrchestrator.run()`,
   replay tìm active attempts và append `phase.failed` với `DUAL_OWNER_DEAD`, `retryable:true`,
   `settlement:true` cho chính attempt mồ côi (không thêm started). Event ghi audit
   `evidence: 'written' | 'reused'` và `evidence_path: raw/<phase>.<attempt>.failure.json`.
   Ghi immutable chấp nhận file đã tồn tại khi bytes giống hệt: trả cùng path/hash,
   không ghi lại và không đổi mtime. Chỉ bytes khác mới bị từ chối bằng
   `DUAL_ARTIFACT_EXISTS`, nên vẫn ngăn thay đổi dữ liệu dưới cùng tên artifact.
   Quy tắc này cho phép thử lại input/schema đã ghi trước khi append started bị crash
   hoặc bị từ chối. Settlement kiểm tra tồn tại trước khi ghi để giữ disposition
   `reused` cho evidence đã có, kể cả khi bytes giống hệt.
   Settlement evidence có đúng ba nhánh:
   - Chưa có: ghi immutable schema_version 1, task/baseline/phase/attempt của run,
     `DUAL_OWNER_DEAD`, retryable/settlement true, reason owner crash/restart,
     provider output `null`, outcome `unknown`, rồi append event.
   - Đã có và hợp lệ: parse JSON, schema_version 1, task/phase/attempt/baseline khớp
     replay, canonical path nằm trong runDir; giữ nguyên từng byte và append event.
     W1 giữ diagnostics failure gốc; W2 giữ settlement evidence từ lần resume bị crash
     trước append. Resume tiếp tái dùng được, không kẹt ở immutable file đã tồn tại.
   - Hỏng/không khớp/path escape: throw rõ ràng, không append event, không ghi đè;
     điều phối phải can thiệp thủ công.

   Event là authoritative cho budget/terminal. Evidence chỉ là diagnostics tại lúc attempt
   chết; evidence tái dùng có thể mang provider error trong khi event là `DUAL_OWNER_DEAD`.
   Consumer KHÔNG suy luận lý do settlement từ `error_code` trong evidence.
   Gọi settlement lần hai cho phase đã đóng/completed bị từ chối.
   Startup/chạy thường không settle; active attempt vẫn chặn bằng `DUAL_ATTEMPT_SEQUENCE`.
   Số attempt thô tăng đơn điệu, không tái dùng số attempt.
   Budget đếm riêng `phase.failed`, loại event có `settlement === true` HOẶC
   `error_code === 'DUAL_OWNER_DEAD'`: tối đa 3 provider failures,
   retryable sau failure 1/2 là true, sau failure 3 là false (giữ phân loại lỗi hiện có).
   Settlement không tiêu budget, không phải terminal failure. Crash ở raw attempt 3
   vẫn dispatch attempt 4 nếu budget còn; terminal-failed task vẫn bị chặn.
7. Resume response/status trả `worker_start` (`scheduled`/`running`/`completed`/`failed`)
   và `worker_running`. RPC chỉ đợi một startup checkpoint, không đợi provider pipeline.
   Lỗi tức thì trả `resumed:false` và `worker_start.error`; lỗi về sau thấy qua
   `session.status.worker_start`. `resumed:true` nghĩa worker đang chạy hoặc đã kết thúc,
   không bảo đảm pipeline thành công; tiếp tục kiểm task state/evidence. Không có task đủ
   điều kiện, lease busy hoặc pipeline incomplete trả `WORKER_NOT_STARTED`.
8. **Sạch:** không unknown → phase chưa terminal tiếp tục từ durable task state.
   Không xóa terminal `phase.failed`. Worker hoàn tất các phase đến `CODEX_QC`/`REVIEW_VALID`
   và adapter trả `AWAITING_CODEX_QC`; Codex QC/authority task verification vẫn theo workflow
   hiện có, không tự ghi `task.completed` để giả kết quả.
9. **Bẩn:** unknown giữ blocked; bridge trả `OUTCOME_UNKNOWN` kèm message/invocation/binding
   refs và `RECOVERY_PROOF_REQUIRED` trước khi nhận question mới. Không tự reconcile từ
   bookkeeping rỗng sau restart. Thu thập failure artifact + journal inspection để báo cáo.
   Reconcile vẫn đòi đầy đủ proof ở §3; không seed/đổi key/start session để né unknown.

`relay.close()` khi unknown giữ lock và throw `OUTCOME_UNKNOWN`, không phải reset.
Live script standalone (không import vào suite node:test):

```sh
OMNI_DUAL_LIVE=1 node test/dual-discussion-restart-live.js /tmp/discussion-restart-report.json
```

Script trigger kill theo journal/task phase state, kill daemon + workers, chờ thật hơn
5 phút và ghi JSON stages/wallMs/evidence. Chạy ở shell cấp cao nhất; sandbox lồng nhau
có thể trả `EPERM`, không dùng làm số liệu live acceptance.
Resume stage chỉ pass khi có lease mới hoặc phase event mới trong 120s; worker chết khi
khởi động fail nhanh `WORKER_NOT_STARTED` kèm release reason nếu có. Dirty terminal
`OUTCOME_UNKNOWN` là kết quả blocked dự kiến. Không đổi logic kill, chờ >5 phút hoặc
provider budget `PROVIDER_MS`; v2 không thêm case kill giữa discussion turn.

Giới hạn còn lại: không suy ra provider outcome từ settlement; discussion journal vẫn
quyết định unknown và chặn dispatch mới. Settlement ghi evidence trước event append;
crash giữa hai bước tái dùng evidence hợp lệ ở lần resume sau. Evidence hỏng/không khớp
giữ fail-closed, cần điều phối kiểm tra; không ghi đè/xóa file để né guard. Worker-start status là
trạng thái trong daemon hiện tại, không phải durable receipt xuyên restart. Isolated
recovery chưa được hỗ trợ; không áp dụng settlement cho đường isolated.

### 4.2 ISOLATED: chưa có crash recovery trong 3.1.2

**Isolated crash recovery chưa có trong 3.1.2.** `task.recover` chỉ báo trạng thái
`NEEDS_PROCESS_EVIDENCE` / `WAITING_FOR_PROCESS` khi chưa đủ điều kiện, giữ fail-closed;
không tự resume execution isolated đã crash. Operation active cũ cần giao thức settlement
và process-tree evidence riêng được duyệt; xác minh PID chết không mở gate operation.
Không reclaim journal isolated, không đổi operation/execution key để né gate hoặc unknown.

Dừng và chuyển điều phối khi integrity/path lỗi, owner death không xác minh được, guard
reclaim còn lại, authority stale, proof thiếu hoặc phase đã terminal-failed. Evidence gồm
revision/version, workspace, session/task/revision/baseline, lease/operation, meta/failure paths,
archive/lock state, journal path và unknown refs. Giữ nguyên events/artifacts và hash-chain.

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

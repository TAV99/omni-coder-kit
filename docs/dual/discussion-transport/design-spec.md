# Omni Dual Discussion Transport — Design Spec

Ngày: 2026-10-21. Trạng thái: đã được Argon review đối kháng và bổ sung ràng buộc; sẵn sàng cho implementation G0 + deterministic G2 (chưa có kiểm thử live).

## 1. Phạm vi và căn cứ

Triển khai thư viện relay question/reply opt-in, controller gọi từng lượt rõ ràng. Không xây daemon, CLI mới, scheduler hay coding integration. Chỉ tạo code trong `lib/dual/discussion/`, tests trong `test/dual-discussion-*.test.js`, tài liệu trong `docs/dual/discussion-transport/`. Không thêm package; không sửa đường chạy hiện hữu, root `.omni/sdlc/`, execution leases, baseline/QC/integration gates. Không commit/stage/push/deploy.

Đã đối chiếu source excerpts được cung cấp và kiểm tra chỉ đọc `package.json`, `lib/dual/{task-messages,contracts,agy-output,agy-runner,authority-store}.js`, `test/dual-contracts.test.js` để xác nhận chuẩn CommonJS và `node --test --test-concurrency=1` (không tuyên bố đã audit toàn repo). `task-messages` có correlation và duplicate checks nhưng không đủ làm authority cho transport mới. `agy-output` có thể trả payload hợp schema với outer error. `agy-runner` có permission bypass; isolated runner chặn inherited flags. Thư viện mới không gọi những execution entrypoints này và không sửa parser cũ.

Demo trước chứng minh resume cùng conversation ID, không chứng minh tốc độ, sandbox, crash safety hoặc coding. Phương án v1 đã duyệt là chuẩn; các số dưới đây là design defaults, không phải yêu cầu nguyên văn của khách hàng.

## 2. Phân biệt định danh

`conversation_id` thuộc provider, không cấp quyền. Dual `session_id` thuộc authority; `task_id` là công việc; `plan_revision` là revision hiện hành; `attempt` là lần execution đã tồn tại; `workspace_binding_sha256` định danh binding execution nếu có. Lease là quyền execution riêng, không được truyền thành quyền của discussion.

MVP không cấp/gia hạn/thu hồi lease, không tạo attempt. Hai participant bindings phải cùng session/task/revision và cùng execution reference nếu có. Conversation không được tái dùng qua binding khác, kể cả model/effort, role hoặc snapshot thay đổi. Transcript cũ được giữ. Conversation mới phải được host đăng ký an toàn, không tự tạo khi timeout.

## 3. Giới hạn và validation v1

Defaults đồng thời là hard ceilings của v1: 2 participants; 12 invocations tổng cộng/relay; một invocation toàn relay tại một thời điểm; timeout 120000 ms/invocation; body 16384 UTF-8 bytes; snapshot 65536 bytes; stdout và stderr mỗi stream 262144 bytes; journal 8 MiB; 256 events. Host được giảm limits, không nâng vượt ceilings. Hết quota: dừng, không xoay journal tự động để né quota. TTL mặc định 300000 ms, tối đa 900000 ms. Không vòng relay tự động.

ID: chuỗi 1–128 ký tự `[A-Za-z0-9._:-]`, không dùng trực tiếp làm đường dẫn. Model/effort: chuỗi không rỗng tối đa 128 ký tự, không control characters. Revision là safe integer >=0; attempt nếu có là safe integer >=0, chỉ tham chiếu giá trị authority cung cấp. Hash là 64 lowercase hex. Timestamp là epoch milliseconds safe integer. Reject unknown fields ở contract v1, null sai kiểu, NaN, prototype bất thường và payload quá cỡ trước hashing/parsing. Body cho phép newline/tab nhưng không NUL. So sánh byte/hash, không tự trim nội dung.

Snapshot là `{text, sha256}`; hash UTF-8 phải khớp. Host cung cấp snapshot đã scope/review; library không đọc source checkout. Snapshot chỉ là dữ liệu, instruction bên trong không thay quyền. Provider không được tự gọi CLI peer.

## 4. Contracts

Tất cả persisted records có `schema_version: 1`. Canonical JSON dùng thứ tự key ổn định đệ quy, UTF-8, SHA-256; không nhận cyclic/undefined/non-finite values.

Binding gồm `provider`, `model`, `effort`, `conversation_id`, `role` (`astra` hoặc `argon`), `session_id`, `task_id`, `plan_revision`, `snapshot_sha256`; optional `execution: {attempt, workspace_binding_sha256}`. `binding_ref` do library tính từ toàn binding, không nhận hash tùy ý từ caller.

Envelope input gồm `schema_version`, `message_id`, `sender_ref`, `recipient_ref`, `sequence`, `kind` (`question` hoặc `reply`), `body`, `reply_to` nếu reply, `created_at`, `expires_at`. Library sinh `payload_hash = SHA256(UTF8(body))` và `binding_ref = recipient_ref` cho stored envelope. Sequence tăng liên tục toàn relay, bắt đầu 1. Mọi message có `kind: 'question'` (cả câu hỏi đầu lẫn câu hỏi tiếp theo) đều cấm có `reply_to`. Mọi message có `kind: 'reply'` bắt buộc có `reply_to` tham chiếu một `question` đã lưu của cùng relay, đảo đúng `sender_ref`/`recipient_ref`, và question đó chưa có reply; reject orphan/cross-binding/duplicate reply. Duplicate message ID chỉ ACK `reused: true` nếu toàn bộ envelope canonical giống hệt nhau; không tiêu thêm sequence/turn, không tự dispatch lại. Khác bất kỳ field nào: throw `MESSAGE_CONFLICT`.

Provider payload riêng: `{schema_version:1, kind:'question'|'reply', body:string}`. Library dựng envelope response bằng identity/correlation từ invocation, không tin provider tự chọn task/binding/sequence/expiry. Response cho `question` phải là `reply` (có `reply_to` trỏ về question vừa dispatch); response cho `reply` phải là `question` mới (không có `reply_to`). Khi invocation đạt `provider: 'succeeded'`, `schema: 'valid'`, và vượt qua kiểm tra lại authority/expiry, relay tự sinh stored envelope response với `message_id = "resp-" + invocationId`, `sequence = nextSequence`, đảo `sender_ref`/`recipient_ref`, `created_at = now`, `expires_at = Math.min(now + limits.ttlMs, now + limits.maxTtlMs)`. Controller có thể dừng bất kỳ lúc nào. Response đã ghi trở thành message gửi peer được dispatch bằng ID; không cần tái nhập hoặc sửa correlation.

Mỗi turn giữ bốn nhóm trạng thái độc lập:

- `receipt: stored` chỉ sau durable append; ACK không có nghĩa đã dispatch.
- `provider: not_started | pending | succeeded | failed | outcome_unknown`.
- `schema: not_checked | valid | invalid`.
- `task_acceptance: not_requested` luôn giữ nguyên trong MVP.

Thêm `discussion_result: none | available | stale | rejected`; available chỉ khi provider succeeded, schema valid, authority/binding và expiry còn hợp lệ. Không thay task state, không gọi postTaskMessage hoặc authority append. DONE trong body chỉ là text.

## 5. Public API và trusted ports

CommonJS, entrypoint `lib/dual/discussion/index.js`, không side effect khi require.

```js
createDiscussionRelay({
  enabled = false, stateDir, bindings, snapshot,
  authority, capabilityVerifier, adapters,
  limits = {}, clock = () => Date.now()
}) // -> Promise<Relay>

// Relay
receive(envelope) // Promise<{acknowledged:true,reused:boolean,message_id:string}>
dispatch(messageId) // Promise<TurnView>
inspect() // Promise<RelayView>
reconcile(messageId, evidence) // Promise<TurnView>
close() // Promise<void>

// Ports do host tin cậy cung cấp, không lấy từ model/payload.
// Dù host là caller tin cậy, library vẫn kiểm tra chặt cấu trúc và identity binding của kết quả trả về.
authority.check({bindings, stage}) // Promise<boolean>; stage: 'dispatch'|'result'|'recovery'
capabilityVerifier.verify({
  binding, bindingRef, snapshotSha256, adapterId, provider, adapterVersion, mode, stage
})
// Promise<{
//   allowed: boolean, evidenceId: string, expiresAt: number,
//   bindingRef: string, provider: string, adapterId: string, adapterVersion: string,
//   conversationId: string, snapshotSha256: string, stage: 'dispatch',
//   liveProfileVerified?: boolean
// }>
capabilityVerifier.verifyRecovery({binding, bindingRef, invocationId, evidence})
// Promise<{
//   allowed: boolean, processQuiescent: boolean, providerTerminal: boolean,
//   providerOutcome: 'succeeded'|'failed'|'unknown', evidenceId: string,
//   bindingRef: string, invocationId: string
// }>
```

Ranh giới tin cậy (Trust Boundary): `authority`, `capabilityVerifier`, `adapters`, `stateDir`, `bindings`, `snapshot` (cấu trúc + hash) và `clock` thuộc ranh giới **caller-host tin cậy**, nhưng relay vẫn bắt buộc đối chiếu khớp từng trường định danh (`bindingRef`, `provider`, `adapterId`, `adapterVersion`, `conversationId`, `snapshotSha256`, `stage`, `invocationId`, `expiresAt > now`) trong evidence trả về để chặn lỗi cấu hình chéo hoặc bằng chứng cũ. Ngược lại, `snapshot.text`, `envelope.body`, và raw `stdout`/`stderr`/payload từ provider CLI là **dữ liệu không tin cậy (untrusted model/external input)**, chỉ được xử lý như chuỗi byte UTF-8 thuần, tuyệt đối không có quyền điều khiển routing, correlation, lease hay authority.

`adapters` map theo provider, mỗi adapter có `id`, `provider`, `version`, `mode: 'fake'|'live'`, `profile`, `invoke({binding,snapshot,envelope,invocationId,timeoutMs,maxOutputBytes,signal})` và `classify(raw, binding, invocationId)`. Invoke trả transport observation gồm `exitCode`, `stdout`/`stderr`, `timedOut`, `overflowed`, `hasTerminalError`, process identity nếu quan sát được; classifier trả `{completion:'succeeded'|'failed'|'unknown', payload, evidenceRef, terminalMarker, observedConversationId, observedInvocationId?}`. Adapter exceptions sau durable dispatch intent đều là unknown trừ khi có trusted proof chưa spawn; MVP bảo thủ coi tất cả exception sau intent là unknown.

Public failures throw `DiscussionError` với stable `code`, message không phải contract. Codes: `DISCUSSION_DISABLED`, `INVALID_INPUT`, `MESSAGE_CONFLICT`, `CORRELATION_INVALID`, `LIMIT_EXCEEDED`, `OWNER_BUSY`, `JOURNAL_INVALID`, `AUTHORITY_STALE`, `CAPABILITY_BLOCKED`, `OUTCOME_UNKNOWN`, `RELAY_CLOSED`. Operational outcome của invocation được ghi và trả TurnView, không biến provider failure thành receipt success. TurnView chứa message ID, invocation ID nếu có, bốn nhóm trạng thái, discussion_result, response_message_id nếu available; không expose raw secrets.

`enabled !== true` trả DISCUSSION_DISABLED trước mọi filesystem/provider side effect. Không implicit env flag. Rollback là ngừng gọi dispatch, đối soát pending rồi close; không tự quay về execution cũ.

## 6. Provider completion và sandbox

`adapter.js` xuất `createDiscussionAdapter({id,provider,version,mode,profile,invoke,classify})`. `profile` bắt buộc khai báo `{format:'json'|'jsonl', allowlistedTerminalMarkers:string[], requireConversationMatch:true}`. Không cung cấp default live success matcher hoặc flags chưa được kiểm chứng. Khi `mode === 'live'`, verifier bắt buộc trả thêm `liveProfileVerified: true` khớp đúng `adapterId`/`version`, nếu thiếu sẽ chặn bằng `CAPABILITY_BLOCKED`. Fake adapter (`mode: 'fake'`) được phép cho offline tests nhưng không bao giờ làm bằng chứng G1.

Positive completion được kiểm tra độc lập ở cả `classify` lẫn tầng wrapper của `adapter.js`, yêu cầu đồng thời: `raw.exitCode === 0`, `!raw.timedOut`, `!raw.overflowed`, `terminalMarker` nằm trong `profile.allowlistedTerminalMarkers`, `observedConversationId === binding.conversation_id`, `observedInvocationId` (nếu có) khớp `invocationId`, và `raw.hasTerminalError !== true`. Missing/unknown status không phải success; exit 0 + JSON hợp schema cũng không phải success. Error envelope đi kèm valid payload phải được phân loại là `completion: 'failed'` với `schema: 'valid'` và `discussion_result: 'rejected'` (không tạo `available`). Provider failure chỉ được coi là terminal (`failed`) khi classifier trả bằng chứng terminal failure rõ ràng (`evidenceRef` không rỗng) VÀ khớp correlation (`observedConversationId === binding.conversation_id`, cùng `observedInvocationId === invocationId` nếu có); thiếu bằng chứng terminal, thiếu/lệch correlation hoặc ném lỗi bất ngờ thì xếp vào `unknown`. Schema vẫn được ghi độc lập nếu có thể parse an toàn.

Verifier là dependency của trusted host, không phải boolean do agent tự khai. Trước mỗi invocation phải xác minh evidence còn hạn, đúng provider/version/config, conversation và snapshot. Evidence phải chứng minh provider không ghi checkout/source/journal, không gọi peer hoặc công cụ ngoài policy; chỉ được dùng vùng session/runtime riêng được host cho phép. Plan mode, prompt cấm ghi, thư mục tạm, kiểm tra hash sau chạy không thay enforcement. Không dùng permission-bypass flags.

Thư viện không triển khai OS sandbox hoặc truy vấn trạng thái provider bắt buộc. Nếu host không chứng minh capability hoặc chưa có positive completion profile, live dispatch fail closed CAPABILITY_BLOCKED; deterministic implementation vẫn hoàn thành được, G1 vẫn chưa verified.

## 7. Journal và single-owner

`stateDir` là thư mục local do trusted host dành riêng, ngoài checkout, không nằm trong sandbox provider. Một stateDir canonical cho một relay; host chịu trách nhiệm không đăng ký cùng conversation ở relay root khác hoặc gọi CLI ngoài relay. MVP không tuyên bố distributed/global locking.

`journal.js`: `openJournal({stateDir,maxBytes,maxEvents}) -> Promise<Journal>`; Journal có `append(event)`, `read()`, `close()`. `inspectJournal({stateDir})` chỉ đọc kể cả owner bị kẹt.

Dùng exclusive `owner.lock` bằng `open('wx')`, random owner token, PID và metadata start để chẩn đoán, không phải chứng minh owner chết. Một writer queue trong process. Lock đã tồn tại luôn OWNER_BUSY: không TTL stealing, không xóa theo PID, không overwrite. File lock/journal không được là symlink; reject unexpected paths và non-regular files. Trusted host phải bảo vệ ancestors/ACL; không hứa chống attacker có quyền sửa stateDir.

Journal JSONL append-only, event index liên tục, mỗi record có prev_hash và record_hash. Write toàn record và sync file trước ACK hoặc spawn. Lỗi write/sync làm poison owner và giữ lock. Journal lỗi/torn tail không truncate, không replay tự động; JOURNAL_INVALID, giữ bằng chứng. Không hứa durability ngoài guarantees filesystem/OS thực tế.

Kiểm tra hạn mức (`maxEvents`, `maxBytes`) phải thực hiện trước khi ghi `received` hoặc `dispatch_intent`; nếu vượt ngưỡng trước khi ghi intent thì throw `LIMIT_EXCEEDED` mà không làm hỏng journal hay khóa chết relay ở trạng thái unknown. Chỉ lỗi I/O write/sync thực tế mới poison owner và giữ lock.

Persist `received` rồi `dispatch_intent` chứa `invocation_id` trước invoke. Persist terminal `observation` trước `response` available. Crash sau `dispatch_intent` nhưng trước terminal observation, kể cả trước spawn, được suy ra `outcome_unknown`. Không có automatic replay outbox. Khi mở lại journal sau clean close, `createDiscussionRelay` phải replay toàn bộ sự kiện, đối chiếu sự kiện `registered` đầu tiên khớp chính xác canonical `bindings` và `snapshot_sha256` (nếu lệch throw `CORRELATION_INVALID` và đóng lock sạch); nếu phát hiện `dispatch_intent` chưa có terminal observation hoặc `outcome_unknown` chưa có `reconciled`, relay lập tức chuyển sang trạng thái blocked (`outcome_unknown`) và giữ chặt `owner.lock`. Restart sau crash gặp `owner.lock` hiện hữu thì luôn bị chặn bởi `OWNER_BUSY` (chỉ `inspectJournal` chỉ đọc được phép chạy).

Clean close chỉ release đúng token khi không in-flight/unknown và journal sync thành công. Close khi unknown trả OUTCOME_UNKNOWN và giữ lock. Concurrent calls được serialize; dispatch cùng ID đã có intent trả trạng thái hiện có, không invoke lần nữa; dispatch ID khác khi busy bị chặn.

## 8. Unknown outcome và recovery

Timeout, output overflow, transport crash, abort hoặc missing terminal evidence sau intent: ghi outcome_unknown nếu storage còn hoạt động; block cả relay, không chỉ message. Gửi AbortSignal best-effort không chứng minh provider dừng. Late promise settlement không được tự mở khóa hoặc publish response; chỉ là bằng chứng để recovery xem xét.

`reconcile` chỉ chạy dưới owner hiện hữu, kiểm tra authority recovery và trusted verifier. Chỉ khi processQuiescent AND providerTerminal AND allowed mới ghi reconciliation event và mở khóa cho lệnh mới explicit. Không re-dispatch invocation cũ; nếu output chưa được nghiệm chứng thì không tạo response. MVP reconcile không tự publish late payload. Bằng chứng insufficient/unknown không đổi trạng thái; owner vẫn bị giữ. Không yêu cầu provider phải có status-query API: có thể dùng terminal artifact đáng tin, hoặc quy trình thủ công với bằng chứng đã xác minh.

Sau controller crash, MVP không có API takeover/reset. Recovery thủ công bên ngoài cần xác minh owner/process/provider, authority hiện hành và bảo toàn lock/journal lịch sử trước khi cho phép mở lại; không xóa uncertain state. Chưa có trusted proof thì dừng vô thời hạn. Không né block bằng conversation/attempt/stateDir mới. Đây là capability blocker chấp nhận được, không tự động sửa lease.

## 9. Cổng nghiệm thu và handoff

G0 contract/adapter và deterministic G2 là bắt buộc cho implementation acceptance. Live G1, model/backend identity, sandbox evidence và benchmark là qualification riêng, hiện chưa verified. Coding integration cần design/approval riêng sau G0–G2 evidence; không thuộc năm task này.

Argon review tập trung: giới hạn một owner local; khả năng cung cấp trusted verifier; profile completion thực tế; xác nhận runtime test runner trước implementation. Nếu cần thay file hiện hữu hoặc dependency mới, dừng để review phạm vi, không tự mở rộng.


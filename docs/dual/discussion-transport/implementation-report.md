# Omni Dual Discussion Transport — Implementation & Verification Report

**Ngày thực hiện:** 2026-10-22
**Người thực hiện:** Gemini 4 Argon Medium (theo spec/plan do Codex GPT-6 Astra Medium soạn thảo và đã được Argon review/amend)
**Phạm vi nghiệm thu đạt được:** **Offline G0 & Deterministic G2 (21/21 feature tests PASS, 5/5 suites PASS)**
**Các cổng CHƯA kiểm chứng (Unverified / Capability Blocked):** **Live G1, Live G2, Benchmark (Q01–Q05 = `NOT VERIFIED / CAPABILITY BLOCKED`)**; **Coding Integration (F01 = `OUT OF SCOPE / NOT APPROVED`)**

---

## 1. Danh sách file mới / cập nhật trong phạm vi được phép

### Production modules (`lib/dual/discussion/`)
- `lib/dual/discussion/contracts.js` — `DiscussionError`, `ERROR_CODES`, `CEILINGS`, `resolveLimits`, `validateBinding`, `bindingRef`, `validateBindingPair`, `validateSnapshot`, `validatePayload`, `validateEnvelope`, canonical JSON và SHA-256 helpers.
- `lib/dual/discussion/journal.js` — `openJournal`, `inspectJournal`, exclusive `owner.lock` (`open('wx')`, không lấy cắp lock theo PID/TTL), hash-chained JSONL append-only, snapshot tham số ngay tại ranh giới hàm công khai (`append`, `close`), kiểm tra quota (`maxEvents`, `maxBytes`) trước khi ghi, đóng an toàn `FileHandle` khi lỗi sync lúc `close()` nhưng vẫn giữ `owner.lock`.
- `lib/dual/discussion/adapter.js` — `createDiscussionAdapter`, kiểm tra `profile` (`format`, `allowlistedTerminalMarkers`, `requireConversationMatch: true`), giữ timer có tham chiếu trong suốt `Promise.race` và dọn sạch trong `finally`, kiểm tra độc lập correlation (`observedConversationId === binding.conversation_id` và `observedInvocationId` khớp `invocationId` nếu có) cho cả nhánh `failed` lẫn nhánh `succeeded`, tách biệt hoàn toàn `completion` và `schema`.
- `lib/dual/discussion/relay.js` — `createDiscussionRelay` (mặc định OFF ném `DISCUSSION_DISABLED` với zero I/O trừ khi `enabled === true`), snapshot đồng bộ đầu vào tại ranh giới `receive` và `reconcile` trước khi xếp hàng microtask, đếm `maxInvocations` theo số lần `dispatch` thực tế (không đồng nhất với `envelope.sequence`), kiểm tra `authority.check` và `capabilityVerifier.verify`/`verifyRecovery` gắn chặt định danh, fail-closed `OUTCOME_UNKNOWN` tại mọi ranh giới lỗi sau `dispatch_intent`.
- `lib/dual/discussion/index.js` — Side-effect-free entrypoint xuất `createDiscussionRelay`, `createDiscussionAdapter`, `inspectJournal`, `openJournal`, `DiscussionError` và các hàm contract.

### Test suites (`test/dual-discussion-*.test.js`)
- `test/dual-discussion-contracts.test.js` (4 tests)
- `test/dual-discussion-journal.test.js` (4 tests)
- `test/dual-discussion-adapter.test.js` (4 tests)
- `test/dual-discussion-relay.test.js` (5 tests)
- `test/dual-discussion-recovery.test.js` (4 tests)

### Tài liệu (`docs/dual/discussion-transport/`)
- `docs/dual/discussion-transport/design-spec.md` (cập nhật ràng buộc A–D và correlation cho terminal failure P1)
- `docs/dual/discussion-transport/requirements.md` (cập nhật R01–R22 PASS, giữ Q01–Q05 `NOT VERIFIED` và F01 `OUT OF SCOPE`)
- `docs/dual/discussion-transport/plan.md` (đánh dấu `[x]` các bước đã hoàn thành và ghi kết quả Checkpoint 1–3)
- `docs/dual/discussion-transport/review.md` (báo cáo review đối kháng spec/plan)
- `docs/dual/discussion-transport/implementation-report.md` (báo cáo triển khai & kiểm chứng này)
- **Bảo toàn nguyên trạng:** `docs/dual/discussion-transport/customer-spec.md`, `docs/dual/discussion-transport/parent-review-followup.md`, và toàn bộ các file dirty sẵn có trong `E:/omni-coder-kit` không bị chỉnh sửa.

---

## 2. Bằng chứng TDD (RED -> GREEN) và xử lý Parent Review Follow-up (P1, P2 & 3 Boundary Checks)

### 2.1. Các chu kỳ TDD ban đầu (Tasks 1–5)
1. **Task 1 (`contracts.js`)**:
   - **RED:** `node --test test/dual-discussion-contracts.test.js` -> `Error: Cannot find module '../lib/dual/discussion/contracts'` (fail 1).
   - **GREEN:** Sau khi triển khai `lib/dual/discussion/contracts.js` -> `pass 4, fail 0`.
2. **Task 2 (`journal.js`) & Checkpoint 1**:
   - **RED:** `node --test test/dual-discussion-journal.test.js` -> `Error: Cannot find module '../lib/dual/discussion/journal'` (fail 1).
   - **GREEN & Checkpoint 1:** `node --test test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js` -> `tests 7, suites 2, pass 7, fail 0`.
3. **Task 3 (`adapter.js`)**:
   - **RED:** `node --test test/dual-discussion-adapter.test.js` -> `Error: Cannot find module '../lib/dual/discussion/adapter'` (fail 1).
   - **GREEN:** `node --test test/dual-discussion-adapter.test.js` -> `tests 3, suites 1, pass 3, fail 0`.
4. **Task 4 (`relay.js`, `index.js`) & Checkpoint 2**:
   - **RED:** `node --test test/dual-discussion-relay.test.js` -> `Error: Cannot find module '../lib/dual/discussion'` (fail 1).
   - **GREEN & Checkpoint 2:** `node --test test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js` -> `tests 14, suites 4, pass 14, fail 0`.
5. **Task 5 (`dual-discussion-recovery.test.js`)**:
   - **RED -> GREEN:** Kiểm tra 5 ranh giới lỗi (`received-before-ACK`, `intent-before-invoke`, `invoke-before-observation`, `observation-before-response`, `unknown-before-close`) -> `tests 18, suites 5, pass 18, fail 0`.

### 2.2. Tái hiện RED và sửa triệt để các điểm trong `parent-review-followup.md`
Sau khi đọc `docs/dual/discussion-transport/parent-review-followup.md`, đã bổ sung 4 regression tests trực tiếp vào các bộ test để tái hiện **RED** trước khi sửa code:

- **Lệnh chạy RED:**
  `node --test --test-concurrency=1 test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js test/dual-discussion-recovery.test.js`
- **Kết quả RED thực tế (`tests 21, pass 17, fail 4`):**
  1. **P1 (`test/dual-discussion-adapter.test.js`):** `AssertionError: actual 'failed', expected 'unknown'` khi `classify({exitCode:1,stdout:'{}',stderr:''}, BINDING, 'expected-invocation')` nhận `observedConversationId: 'OTHER'`, `observedInvocationId: 'OTHER'`, `evidenceRef: 'unrelated-terminal'`.
  2. **P2 trên `journal.append` (`test/dual-discussion-journal.test.js`):** `AssertionError: actual 'mutated', expected 'original'` khi caller sửa `event.message_id` và `event.nested` ngay sau `const pending = j.append(event)` trước khi `await pending`.
  3. **P2 trên `relay.receive` (`test/dual-discussion-relay.test.js`):** `AssertionError: actual 'Mutated question after call', expected 'Original question before yield'` khi caller sửa `mutableEnv.body` ngay sau khi gọi `relay.receive(mutableEnv)`.
  4. **P2 trên `relay.reconcile` (`test/dual-discussion-recovery.test.js`):** `AssertionError: actual 'mutated-after-call', expected 'verified process dead and provider settled'` khi caller sửa `mutableRecoveryEvidence` ngay sau khi gọi `relay.reconcile('q-1', mutableRecoveryEvidence)`.

- **Các sửa đổi trực tiếp bằng `apply_patch` để đạt GREEN (kèm 3 boundary checks):**
  1. **Sửa P1 (`lib/dual/discussion/adapter.js`):** Tính `hasCorrelationMatch = observedConversationId === binding.conversation_id && (observedInvocationId === null || observedInvocationId === invocationId)` và bắt buộc `hasCorrelationMatch` ở cả nhánh terminal `failed` lẫn nhánh positive `succeeded`. Khi correlation bị thiếu (`null`) hoặc lệch (`'OTHER'`), kết quả trả về là `completion: 'unknown'` (fail-closed), trong khi trường hợp outer error có correlation khớp và payload hợp lệ vẫn trả `completion: 'failed'` + `schema: 'valid'`.
  2. **Sửa P2 (`lib/dual/discussion/journal.js`, `lib/dual/discussion/relay.js`):** Snapshot và đóng băng đệ quy (`cloneAndFreeze`) tham số đầu vào ngay tại ranh giới hàm công khai (`journal.append`, `journal.close`, `relay.receive`, `relay.reconcile`) **trước** khi đưa hàm xử lý vào hàng đợi promise (`enqueue` / `enqueueState`).
  3. **Boundary 1 — `maxInvocations` đếm `dispatch`, không đếm `envelope.sequence` (`lib/dual/discussion/contracts.js`, `lib/dual/discussion/relay.js`):** Gỡ bỏ kiểm tra đồng nhất `sequence > maxInvocations` trong `validateEnvelope`; `maxInvocations` được kiểm tra chính xác theo `invocationCount` trong `relay.dispatch`. Đã kiểm chứng với `maxInvocations: 1` (lưu thành công response `sequence: 2` sau invocation thứ nhất, chặn invocation thứ hai bằng `LIMIT_EXCEEDED`) và với đủ 12 lượt `receive` + `dispatch` tường minh (lưu đủ 24 envelopes tới `sequence: 24` cho 12 invocations, và chặn dispatch thứ 13 bằng `LIMIT_EXCEEDED`).
  4. **Boundary 2 — Timeout-only fake invocation khi không còn event-loop handle nào khác (`lib/dual/discussion/adapter.js`):** Bỏ `timer.unref()` trên bộ đếm timeout của `adapter.invoke` (vẫn luôn `clearTimeout(timer)` trong `finally`), đảm bảo fake invocation dạng `() => new Promise(() => {})` giữ event loop sống đến khi hết `timeoutMs` và trả về `timedOut: true` thay vì bị hủy sớm.
  5. **Boundary 3 — Dọn dẹp `FileHandle` khi `close()` bị lỗi sync (`lib/dual/discussion/journal.js`):** Bổ sung `safeCloseJournalHandle()` trong `catch`/`finally` của `closeInternal`, đảm bảo khi `syncHook` hoặc `journalHandle.sync()` ném lỗi lúc `close()`, `owner.lock` vẫn được giữ lại trên đĩa (`locked: true`), trạng thái journal chuyển sang `poisoned`, và `journalHandle.close()` vẫn được gọi đúng 1 lần (không rò rỉ file descriptor).

---

## 3. Bảng đối chiếu R01–R22 (Offline G0 & Deterministic G2)

| ID | Yêu cầu | Cài đặt thực tế | Test kiểm chứng | Trạng thái |
|---|---|---|---|---|
| R01 | Default OFF, opt-in chỉ bằng `enabled === true` | `createDiscussionRelay` kiểm tra `options.enabled === true` trước mọi I/O | `test/dual-discussion-relay.test.js` (`R01`) | **PASS** |
| R02 | Additive, không đổi execution hay leases | Chỉ tạo file mới trong `lib/dual/discussion/`, `test/dual-discussion-*.test.js`, `docs/dual/discussion-transport/` | `git status --short` & `git diff --check` | **PASS** |
| R03 | Binding đầy đủ, không attempt giả | `validateBinding`, `bindingRef`, `validateBindingPair` trong `contracts.js` | `test/dual-discussion-contracts.test.js` (`R03`) | **PASS** |
| R04 | Snapshot scoped và có hash | `validateSnapshot` kiểm tra giới hạn 65536 bytes UTF-8, NUL byte và SHA-256 | `test/dual-discussion-contracts.test.js` (`R04`) | **PASS** |
| R05 | Validate contract strict | `validatePayload`, `validateEnvelope`, `resolveLimits` kiểm tra byte UTF-8 (gồm tiếng Việt), prototype, unknown fields | `test/dual-discussion-contracts.test.js` (`R05 & R18`) | **PASS** |
| R06 | Receipt idempotent và conflict rõ | `validateEnvelope` và `relay.receive` trả `reused: true` khi khớp canonical, ném `MESSAGE_CONFLICT` khi lệch; snapshot tại call boundary (P2) | `test/dual-discussion-contracts.test.js`, `test/dual-discussion-relay.test.js` | **PASS** |
| R07 | Correlation không lẫn task | `validateBindingPair` và `validateEnvelope` kiểm tra sequence, đảo `sender_ref`/`recipient_ref`, cấm question có `reply_to`, cấm duplicate reply | `test/dual-discussion-contracts.test.js` (`R06 & R07 & R21`) | **PASS** |
| R08 | Positive completion riêng provider/version | `createDiscussionAdapter` kiểm tra `exitCode === 0`, allowlisted `terminalMarker`, `observedConversationId === binding.conversation_id`, `observedInvocationId` khớp `invocationId` cho cả `succeeded` và `failed` (P1) | `test/dual-discussion-adapter.test.js` (`R08`, `P1 regression`) | **PASS** |
| R09 | Bốn trạng thái độc lập | Tách `receipt`, `provider`, `schema`, `task_acceptance: 'not_requested'`; outer error + valid payload ghi `provider: 'failed'`, `schema: 'valid'`, `discussion_result: 'rejected'` | `test/dual-discussion-adapter.test.js` (`R09`), `test/dual-discussion-relay.test.js` | **PASS** |
| R10 | Capability fail closed với identity binding | `verifyCapabilityEvidence` đối chiếu `bindingRef`, `provider`, `adapterId`, `adapterVersion`, `conversationId`, `snapshotSha256`, `stage`, `expiresAt > now`, và `liveProfileVerified` | `test/dual-discussion-relay.test.js` (`R10 & R11`) | **PASS** |
| R11 | Authority hiện hành | Kiểm tra `authority.check` ở cả `dispatch`, `result` (đánh dấu `stale` nếu đổi revision trong khi invoke) và `recovery` | `test/dual-discussion-relay.test.js` (`R10 & R11`), `test/dual-discussion-recovery.test.js` | **PASS** |
| R12 | Durable receipt/intent | `journal.append` ghi và `sync()` trước khi ACK hoặc invoke; lỗi sync trước invoke giữ lock và không gọi provider | `test/dual-discussion-journal.test.js`, `test/dual-discussion-recovery.test.js` (`Boundary 1 & 2`) | **PASS** |
| R13 | Single dispatch owner | `openJournal` dùng `fsp.open(lockPath, 'wx')`, không lấy cắp lock theo PID hay TTL, kiểm tra `owner_token` khi đóng | `test/dual-discussion-journal.test.js` (`R13 & R19`) | **PASS** |
| R14 | Restart fail closed | Torn tail / hash tamper / index gap ném `JOURNAL_INVALID` mà không truncate; `dispatch_intent` hoặc `observation` chưa có `response` khi replay tự khóa ở `blocked: true` | `test/dual-discussion-journal.test.js` (`R12 & R14`), `test/dual-discussion-recovery.test.js` | **PASS** |
| R15 | At most one active invocation | `dispatch` đồng thời khác ID bị từ chối ngay bằng `OWNER_BUSY`; cùng ID dùng chung promise và chỉ invoke 1 lần | `test/dual-discussion-relay.test.js` (`R15 & R18`) | **PASS** |
| R16 | Unknown không tự hồi phục | Timeout, overflow, exception hoặc lỗi ghi `observation`/`response` sau intent chuyển sang `OUTCOME_UNKNOWN`, bỏ qua late completion | `test/dual-discussion-recovery.test.js` (`Boundary 3 & 4`, `Boundary 5`) | **PASS** |
| R17 | Recovery cần hai lớp evidence có gắn định danh | `verifyRecoveryEvidence` đòi hỏi `processQuiescent === true`, `providerTerminal === true`, `providerOutcome` rõ ràng, khớp `bindingRef` & `invocationId`; snapshot `evidence` tại call boundary (P2) | `test/dual-discussion-recovery.test.js` (`Boundary 5`, `R14, R17, R19`) | **PASS** |
| R18 | Bounded resource use | Kiểm tra trần 16384B body, 65536B snapshot, 262144B stdout/stderr, 8MiB/256 events journal trước khi ghi, và 12 `maxInvocations` theo số lần `dispatch` (lưu đủ response cuối cùng ở `maxInvocations: 1` và 12 lượt `receive`+`dispatch`) | `test/dual-discussion-contracts.test.js`, `test/dual-discussion-journal.test.js`, `test/dual-discussion-relay.test.js` | **PASS** |
| R19 | Restart/close/rollback rõ | Clean close cho phép reopen khi khớp `bindings` & `snapshot_sha256`; close khi unknown ném `OUTCOME_UNKNOWN` và giữ lock; close lỗi sync giữ lock và vẫn đóng `FileHandle` | `test/dual-discussion-journal.test.js`, `test/dual-discussion-recovery.test.js` | **PASS** |
| R20 | API relay dùng được | Hội thoại 2 chiều A -> B -> A hoạt động hoàn chỉnh với synthetic fixtures, giữ `task_acceptance: 'not_requested'` | `test/dual-discussion-relay.test.js` (`R06, R09, R20`) | **PASS** |
| R21 | Snapshot và journal không là quyền | Từ chối `lease_id` hoặc unknown fields; dữ liệu body/snapshot không thể thay đổi ports hay quyền | `test/dual-discussion-contracts.test.js`, `test/dual-discussion-adapter.test.js` | **PASS** |
| R22 | Journal được bảo vệ trong phạm vi host | Từ chối symlink, non-regular file, file lạ trong `stateDir`; serialize mọi thao tác append | `test/dual-discussion-journal.test.js` (`R18 & R22`, `P2 regression`) | **PASS** |

---

## 4. Bảng trạng thái Live Qualification (Q01–Q05) và Future Scope (F01)

| ID | Hạng mục | Trạng thái hiện tại | Lý do / Rào cản kỹ thuật |
|---|---|---|---|
| Q01 / G1 | Live CLI resume 2 chiều đúng binding | **NOT VERIFIED / CAPABILITY BLOCKED** | Chưa chạy provider CLI thật (AGY / Codex); chỉ kiểm chứng bằng synthetic offline fixtures. |
| Q02 / G1 | Capability enforcement / OS sandbox thật | **NOT VERIFIED / CAPABILITY BLOCKED** | Host chưa cung cấp cơ chế OS sandbox thực tế và `capabilityVerifier` chứng thực vùng ghi cô lập cho live CLI. |
| Q03 / G1 | Positive completion profile thật theo version | **NOT VERIFIED / CAPABILITY BLOCKED** | Chưa thu thập và xác minh bộ `allowlistedTerminalMarkers` thực nghiệm cho từng phiên bản AGY / Codex CLI thật. |
| Q04 / G2 live | Fault provider/process thực | **NOT VERIFIED / CAPABILITY BLOCKED** | Phụ thuộc Q01–Q03; chưa chạy fault injection trên tiến trình CLI live. |
| Q05 | Benchmark theo protocol định trước | **NOT VERIFIED / CAPABILITY BLOCKED** | Chưa có phép đo live; tuyệt đối không suy diễn tốc độ hay độ tin cậy từ offline tests. |
| F01 | Coding integration vào execution pipeline | **OUT OF SCOPE / NOT APPROVED** | Không nằm trong phạm vi MVP; giữ nguyên mọi guard của `isolated-runner.js`, `agy-runner.js`, `task-messages.js`. |

---

## 5. Kết quả thực thi Checkpoint 3 & Baseline kiểm chứng cuối cùng

1. **Chạy toàn bộ 5 bộ test tính năng mới:**
   - Lệnh: `node --test --test-concurrency=1 test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js test/dual-discussion-recovery.test.js`
   - Kết quả: `tests 21, suites 5, pass 21, fail 0, cancelled 0`.
2. **Kiểm tra cú pháp (`node --check`):**
   - Đã chạy `node --check` trên cả 5 module trong `lib/dual/discussion/*.js` và 5 file test trong `test/dual-discussion-*.test.js` -> `ALL_SYNTAX_OK` (exit code 0).
3. **Kiểm tra whitespace/patch format (`git diff --check`):**
   - Lệnh: `git diff --check` -> exit code 0 (không có lỗi khoảng trắng hay conflict marker).
4. **Kiểm tra baseline của repository:**
   - Test kế cận `node --test --test-concurrency=1 test/dual-contracts.test.js` -> `tests 39, suites 8, pass 39, fail 0`.
   - Full baseline (`npm test` -> `node --test --test-concurrency=1`) có 1 lỗi sẵn có không liên quan tới tính năng này tại `test/dual-task-workspace.test.js` (`createTaskWorkspace copies isolated checkout and blocks dirty source when requested`: lỗi Windows `UNKNOWN: unknown error, scandir '.../bad-source'`). Không chạm vào file test hay code cũ theo đúng quy định phạm vi.

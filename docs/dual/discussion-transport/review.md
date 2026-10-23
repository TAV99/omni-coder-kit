# Adversarial Spec & Plan Review — Omni Dual Discussion Transport

- **Reviewer:** Gemini 4 Argon Medium
- **Author:** Codex GPT-6 Astra Medium
- **Ngày review:** 2026-10-21
- **Quyết định:** **APPROVED** (cho triển khai offline **G0** và **deterministic G2** sau khi đã áp dụng các bản vá A–D vào `design-spec.md`, `requirements.md`, `plan.md`; giữ nguyên `customer-spec.md` nguyên văn)
- **Phạm vi được duyệt (Exact Scope):**
  - Chỉ tạo code mới trong `lib/dual/discussion/{contracts,journal,adapter,relay,index}.js`.
  - Chỉ tạo unit/fault tests mới trong `test/dual-discussion-{contracts,journal,adapter,relay,recovery}.test.js`.
  - Chỉ cập nhật tài liệu trong `docs/dual/discussion-transport/`.
  - Bảo toàn tuyệt đối worktree đang dirty; không sửa file hiện hữu, không thêm package, không chạm `isolated-runner.js`, `agy-runner.js`, `agy-output.js`, `task-messages.js` hay `.omni/sdlc/`.
  - Chỉ nghiệm thu offline implementation (**G0** và **deterministic G2**). Các hạng mục **G1 live**, **G2 live**, **benchmark (Q01–Q05)** và **coding integration (F01)** hiện ở trạng thái **NOT VERIFIED / OUT OF SCOPE**.

---

## 1. Các Phát hiện Đối kháng (Adversarial Findings) & Bản vá Đã Áp dụng

### A. Thiếu trường định danh trong kết quả trả về của `capabilityVerifier` (Identity Binding Gap)
- **Vấn đề:** Bản thảo `design-spec.md` mục 6 và `R10` yêu cầu xác minh evidence của verifier khớp đúng `binding`, `provider/version`, `conversation_id` và `snapshot_sha256`, nhưng chữ ký ở mục 5 chỉ trả về `{allowed, evidenceId, expiresAt}` cho `verify()` và `{allowed, processQuiescent, providerTerminal, providerOutcome, evidenceId}` cho `verifyRecovery()`. Nếu chỉ trả boolean + timestamp, relay không có dữ liệu định danh trong evidence để đối chiếu chống cấu hình nhầm (miswired verifier) hoặc dùng lại evidence của binding/invocation khác.
- **Cách khắc phục (đã áp dụng vào `design-spec.md`, `requirements.md`, `plan.md`):**
  - `capabilityVerifier.verify({binding, bindingRef, snapshotSha256, adapterId, provider, adapterVersion, mode, stage})` phải trả về đầy đủ `{allowed, evidenceId, expiresAt, bindingRef, provider, adapterId, adapterVersion, conversationId, snapshotSha256, stage, liveProfileVerified?}` và relay phải so khớp từng trường với invocation hiện tại (sai lệch -> `CAPABILITY_BLOCKED`).
  - `capabilityVerifier.verifyRecovery({binding, bindingRef, invocationId, evidence})` phải trả về `{allowed, processQuiescent, providerTerminal, providerOutcome, evidenceId, bindingRef, invocationId}` và relay chỉ mở khóa khi khớp đúng `bindingRef` và `invocationId` đang bị khóa, đồng thời `providerOutcome` là `'succeeded'` hoặc `'failed'` (không phải `'unknown'`).

### B. Phân định Ranh giới Tin cậy giữa Caller-Host và Model/External Input
- **Vấn đề:** Cần làm rõ tại sao các port do host truyền vào là trusted nhưng vẫn phải kiểm tra kết quả, và dữ liệu nào là hoàn toàn untrusted.
- **Cách khắc phục (đã áp dụng vào mục 5 `design-spec.md`):**
  - Các port (`authority`, `capabilityVerifier`, `adapters`, `stateDir`, `bindings`, `snapshot`, `clock`) thuộc ranh giới **caller-host tin cậy** (không bao giờ lấy từ model/payload), nhưng relay vẫn kiểm tra schema/identity/expiry của dữ liệu trả về để fail-closed trước lỗi tích hợp.
  - `snapshot.text`, `envelope.body` và raw `stdout`/`stderr`/payload từ CLI là **untrusted input**, chỉ được xử lý như chuỗi byte UTF-8, không bao giờ cấp quyền hay chọn binding/sequence/lease.

### C. Ràng buộc Parsing Dương tính theo Provider/Profile (`adapter.js`)
- **Vấn đề:** Trong repo hiện chỉ có `lib/dual/agy-output.js` (vốn chấp nhận `status === 'error'` kèm `structured_output` và không kiểm tra `conversation_id`), chưa có live fixture đã kiểm chứng cho `agy --conversation` hay `codex exec resume`. Nếu `createDiscussionAdapter` chỉ ủy quyền toàn bộ cho hàm `classify` tự do của caller thì có nguy cơ lọt completion giả.
- **Cách khắc phục (đã áp dụng vào mục 6 `design-spec.md`, `R08`, `R09`, Task 3 `plan.md`):**
  - `createDiscussionAdapter` yêu cầu cấu hình `profile: {format: 'json'|'jsonl', allowlistedTerminalMarkers: string[], requireConversationMatch: true}`.
  - Wrapper của `adapter.js` tự cưỡng chế độc lập: `raw.exitCode === 0`, `!raw.timedOut`, `!raw.overflowed`, `!raw.hasTerminalError`, `profile.allowlistedTerminalMarkers.includes(terminalMarker)`, và `observedConversationId === binding.conversation_id`.
  - Khi gặp error envelope có JSON đúng schema, trạng thái phải được ghi nhận là `provider: 'failed'`, `schema: 'valid'`, `discussion_result: 'rejected'`.
  - Khi `mode === 'live'`, nếu verifier không chứng nhận `liveProfileVerified: true` thì chặn cứng bằng `CAPABILITY_BLOCKED`.

### D. Độ bền Journal, Kiểm tra Quota Trước Ghi, Reopen Matching, Envelope Tự sinh & Convention Repo
- **Cách khắc phục (đã áp dụng vào mục 4 & 7 `design-spec.md`, `R18`, `R19`, `plan.md`):**
  1. **Quota trước ghi:** Kiểm tra `maxEvents` (256) và `maxBytes` (8 MiB) trước khi ghi `received` / `dispatch_intent`; nếu vượt ngưỡng trước khi ghi intent chỉ ném `LIMIT_EXCEEDED`, giữ journal nguyên vẹn. Chỉ lỗi I/O write/sync thực sự mới poison owner.
  2. **Reopen matching:** Khi reopen journal đã có dữ liệu, relay bắt buộc đối chiếu sự kiện `registered` khớp canonical `bindings` và `snapshot_sha256` (lệch -> `CORRELATION_INVALID` và đóng lock sạch), và nếu có `dispatch_intent` chưa hoàn tất hoặc `outcome_unknown` chưa `reconciled` thì khóa ngay ở trạng thái `outcome_unknown` và giữ `owner.lock`.
  3. **Envelope tự sinh tất định:** Mọi `question` không bao giờ có `reply_to`; mọi `reply` bắt buộc có `reply_to` trỏ tới `question` chưa trả lời; response hợp lệ được ghi thành envelope với `message_id = "resp-" + invocationId`, `sequence = nextSequence`, đảo chiều `sender_ref`/`recipient_ref`, `created_at = now`, `expires_at = Math.min(now + limits.ttlMs, now + limits.maxTtlMs)`.
  4. **Convention Repo:** Đã xác nhận từ `package.json` và `test/dual-contracts.test.js` rằng repo dùng CommonJS (`"type": "commonjs"`, Node `>=20.0.0`) và `node --test --test-concurrency=1` với `node:assert/strict`.

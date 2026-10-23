# Handoff WIP — Astra / Argon Dual Discussion Transport

## Cập nhật checkpoint code — 2026-10-23

Theo yêu cầu tiếp theo của người dùng, nhánh `codex/dual-wip-checkpoint` lưu toàn bộ 37 file code/test/package/template đang thay đổi trong working tree, bao gồm implementation discussion, các thay đổi Dual có sẵn và lịch sử local tới `652bcec`. Bộ 8 tài liệu spec/plan/review/handoff cũng đi cùng nhánh này. Không merge vào nhánh cũ, không release/deploy; ignored logs/cache/secrets không thuộc checkpoint.

**Trên nhánh checkpoint này, code không còn chỉ ở local:** có thể clone nhánh để tiếp tục kiểm tra. Các ghi chú “chỉ push tài liệu”, “chưa commit/push implementation” bên dưới là lịch sử của snapshot `codex/dual-discussion-handoff` trước khi người dùng cấp quyền push code. Các giới hạn final QC/live qualification/benchmark vẫn giữ nguyên; checkpoint WIP không đồng nghĩa nghiệm thu.

## Snapshot handoff tài liệu trước đó

Ngày chốt snapshot: 2026-10-23 (Asia/Saigon). Đây là bàn giao công việc còn dang dở, không phải release hoặc nghiệm thu live.

## 1. Đọc trước khi tiếp tục

- Người dùng yêu cầu: Astra viết spec/plan; Argon review, sửa tài liệu nếu cần, rồi chính Argon sửa code. Ngày 2026-10-23 người dùng cho phép push cả spec/plan chưa hoàn thiện và handoff.
- **Snapshot push này chỉ chứa tài liệu.** Năm module và năm test mới vẫn ở working tree local `E:/omni-coder-kit`, chưa nằm trong commit handoff. Clone riêng nhánh handoff không có implementation này; cần lấy lại code local trước khi tiếp tục QA.
- Branch tài liệu: `codex/dual-discussion-handoff`, base remote `codex/v3.1.2` tại `bf11a9bfb4b4fc07e2129c5bf4993e73f3271862`. Không đưa commit local ngoài phạm vi `652bcec` hay các thay đổi code khác vào nhánh này.
- Các bảng PASS trong báo cáo của Argon là kết luận của implementer. Parent đã chạy lại focused tests, nhưng chưa thực hiện final review đầy đủ từng R01–R22. Không hiểu `[x]` trong plan là toàn bộ dự án Dual đã hoàn thành.
- Các câu “không commit/push” trong spec/plan ghi lại giới hạn lượt triển khai trước. Ủy quyền mới chỉ cho phép checkpoint tài liệu này; không cho phép deploy, release, merge hay publish package.

## 2. Hai phiên và cách phối hợp thật

| Vai trò | CLI / model yêu cầu | Conversation ID |
|---|---|---|
| Tác giả spec/plan | Codex `gpt-6-astra`, reasoning `medium` | `01a15d65-b02d-7272-adf9-f890526e1d08` |
| Reviewer và implementer | AGY `gemini-4-argon-medium`, effort `medium` | `a2d46b6b-f54b-45be-82bb-e0380cdd37d1` |

Ba vòng thảo luận: đề xuất độc lập → phản biện chéo → cả hai APPROVE shared proposal v1. Parent chuyển phản hồi giữa hai CLI; không phải hai model tự kết nối chỉ nhờ biết session ID. Codex model/effort đã được kiểm tra trong turn context ở lượt trước; AGY CLI nhận đúng model flag, không có bằng chứng riêng xác nhận model phía backend.

Astra gặp lỗi shell `helper_unknown_error: setup refresh had errors`. Parent đưa source/skills vào cùng phiên và lưu spec/plan do Astra trả về bằng apply_patch. Argon đọc file thực, review và áp dụng amendments A–D trước implementation. Parent làm QC độc lập, không giả làm Argon để viết code.

AGY headless từng bị từ chối RunCommand. Người dùng cho phép `--dangerously-skip-permissions` cho invocation triển khai có phạm vi; CLI xác nhận `permission_mode: always-proceed`. Không biến cờ này thành mặc định sản phẩm và không xem nó là bằng chứng sandbox an toàn.

## 3. Những gì đã thống nhất và lý do

1. Conversation ID giữ continuity nhưng không cấp authority. Omni/controller sở hữu relay, không cho agent gọi CLI peer đệ quy.
2. MVP là thư viện discussion-only opt-in, default OFF (`enabled === true` mới hoạt động). Đọc bounded snapshot, không tích hợp execution/coding, không thay leases hoặc guards cũ.
3. Binding versioned gồm provider/model/effort/conversation/role + Dual session/task/revision/snapshot hash; tham chiếu attempt/workspace hash chỉ khi đã có. Không resume xuyên scope mới.
4. Envelope có ID, sequence, reply correlation, hash và expiry. Journal/outbox durable, single owner, tối đa một invocation đồng thời. Không hứa exactly-once ở provider.
5. Tách receipt ACK, provider completion, schema validity và task acceptance. Body chứa `DONE` không đóng task.
6. Timeout/crash không rõ outcome phải block; recovery cần evidence cả OS/process và provider có gắn identity. Không retry mù, tự tạo attempt/conversation hoặc lấy cắp lock cũ.
7. Evidence sandbox, completion profile và capability phải do trusted host cung cấp; temp directory/plan mode không đủ. Thiếu evidence thì live bị chặn.
8. Chỉ đo lợi ích sau benchmark có protocol/sample/threshold định trước. Chưa chứng minh nhanh hơn, rẻ hơn hay tin cậy hơn.

Amendments Argon đã review: A — identity-bound capability/recovery evidence; B — phân biệt trusted host ports và untrusted model text; C — explicit completion allowlist/correlation; D — quota trước write, reopen matching, response envelope tất định và chuẩn CommonJS/node:test.

## 4. Implementation local và điểm dừng

Đã có local:

- `lib/dual/discussion/{contracts,journal,adapter,relay,index}.js`.
- `test/dual-discussion-{contracts,journal,adapter,relay,recovery}.test.js`.

Lượt implementation đầu đạt 18 tests nhưng CLI timeout khi hoàn thiện docs. Parent phát hiện P1: failure evidence không khớp invocation vẫn bị coi là terminal failed; P2: input mutation sau khi gọi append nhưng trước khi queue chạy làm thay đổi dữ liệu lưu.

Lượt resume cùng Argon đã sửa P1 và P2, mở rộng snapshot-at-call sang receive/reconcile/close, bỏ timer.unref để timeout-only invocation có thể settle, đóng FileHandle khi close-sync lỗi nhưng giữ lock, và tách số invocations khỏi envelope sequence. Argon ghi report ngày 2026-10-22 và đánh dấu tasks 1–5 hoàn thành trong phạm vi offline.

Log lượt review-fixes kết thúc bằng CLI/stream/language-server shutdown lúc 2026-10-22 02:23 giờ local; **không tiếp tục mô tả Argon đang chạy từ lượt cũ**. Lượt handoff này không launch/resume agent mới. Trước resume lần tới phải kiểm tra trạng thái hiện hành, không gửi đồng thời hai resume vào cùng conversation.

## 5. Evidence và giới hạn

Parent kiểm tra lại ngày 2026-10-23:

- Năm feature suites: **21 tests PASS, 0 fail, 0 cancelled**.
- `node --check`: **10/10 files PASS** (5 module + 5 tests).
- SHA-256 baseline 27 file dirty/untracked từ trước: **27 checked, 0 changed**.
- Các sửa P1/P2 và boundary có regression tests đang PASS. Đây không thay thế audit toàn bộ implementation.

Evidence lịch sử, không rerun trong lượt handoff: 53/53 adjacent tests PASS; npm audit 0 vulnerabilities. Full `npm test` trước đó không xanh do Windows `UNKNOWN: unknown error, scandir` ở `test/dual-task-workspace.test.js`; đường dẫn lỗi khác giữa các lượt. Không kết luận toàn repo PASS hoặc chỉ còn đúng một lỗi nếu chưa có full output mới.

Lệnh focused kiểm tra lại:

```powershell
node --test --test-concurrency=1 test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js test/dual-discussion-recovery.test.js
```

Trạng thái:

| Hạng mục | Trạng thái bàn giao |
|---|---|
| Shared proposal / spec-plan review | APPROVED cho phạm vi offline; tài liệu checkpoint WIP |
| Offline G0 / deterministic G2 | Argon báo đạt; parent xác nhận suite 21/21, final requirement-level review còn thiếu |
| Live G1 / live G2 (Q01–Q04) | NOT VERIFIED / CAPABILITY BLOCKED |
| Benchmark (Q05) | NOT VERIFIED |
| Coding integration (F01) | OUT OF SCOPE / NOT APPROVED |
| Full-repo release readiness | NOT ESTABLISHED |

“Chưa chạy CLI thật” trong implementation-report phải hiểu là chưa chạy CLI qua **thư viện transport mới** để qualify live. Hai phiên CLI đã thật sự được dùng để thảo luận, author/review và implementation trước đó.

## 6. Việc người tiếp nhận cần làm

1. Đọc handoff này → customer-spec → design-spec → review → plan/requirements → implementation-report → parent-review-followup. Giữ customer-spec nguyên văn.
2. Lấy implementation từ working tree local; kiểm tra dirty state và không ghi đè 27 file ngoài scope. Snapshot tài liệu remote không đủ phục hồi code.
3. Final QC độc lập từng R01–R22 và từng assertion, không suy coverage từ tên test. Kiểm tra thêm concurrency, replay, crash boundaries, expiry, quotas và handle/lock cleanup.
4. Làm rõ P1: implementation hiện yêu cầu conversation khớp nhưng cho phép thiếu `observedInvocationId` nếu profile không cung cấp. Báo cáo diễn đạt “missing correlation” không được suy thành mọi ID đều bắt buộc; reviewer cần chốt mức evidence phù hợp trước live.
5. Đối chiếu các PASS/checkmarks với bằng chứng, cập nhật parent-review-followup sau final review. File này vẫn giữ findings lịch sử, không có nghĩa các lỗi chưa được sửa.
6. Chạy focused + adjacent + full baseline khi phù hợp; giữ lỗi baseline riêng, không tự sửa module ngoài scope. Chưa commit/push implementation nếu chưa được người dùng cho phép rõ phạm vi đó.
7. Live phase cần host sandbox/capability thật và provider/version-specific completion fixtures; không dùng bypass flag để thay evidence. Benchmark protocol phải chốt trước đo. Coding integration cần phê duyệt riêng.

## 7. Tài liệu và bằng chứng tiếp tục

- [Customer spec / shared proposal](customer-spec.md)
- [Design spec](design-spec.md), [Requirements](requirements.md), [Plan](plan.md)
- [Argon review A–D](review.md)
- [Argon implementation report](implementation-report.md)
- [Parent review findings lịch sử](parent-review-followup.md)

Bằng chứng local bổ sung (không upload raw logs, không có sẵn trong clone remote): thư mục `C:/Users/TAV/AppData/Local/Temp/omni-dual-debate-ac6b7514cad44d7e8711cb4c00e1f010/` chứa `omni-dual-cli-debate.md` (transcript), `astra-spec-result.json`, `argon-implementation.log`, `argon-review-fixes.log`, `preimplementation-hashes.json`. Temp files có thể bị hệ điều hành dọn; handoff này lưu các quyết định và kết quả chính, không thay raw evidence.

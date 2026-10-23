# Discussion Transport — Atomic Requirements

Trạng thái: Đã hoàn tất implementation và kiểm chứng offline G0 + deterministic G2 (`21/21` tests PASS trong 5 suites; xem `implementation-report.md`). Các cổng live G1, live G2, benchmark (Q01–Q05) giữ nguyên `NOT VERIFIED / CAPABILITY BLOCKED`; F01 giữ nguyên `OUT OF SCOPE`. Chỉ dựa source/skills relay; không phải full-repo audit. Các giới hạn số là design defaults của spec.

## A. Implementation acceptance — G0 và deterministic G2

| ID | Yêu cầu kiểm chứng | Test cụ thể / task |
|---|---|---|
| R01 | Default OFF, opt-in chỉ bằng enabled === true | Require module và create thiếu/false/string true: không tạo stateDir, không gọi ports; T4 |
| R02 | Additive, không đổi execution hay leases | Diff chỉ có docs namespace, lib/dual/discussion và test/dual-discussion-*.test.js; không package/root SDLC/daemon edits; T5 |
| R03 | Binding đầy đủ, không attempt giả | Valid binding có/không execution; reject execution thiếu hash/attempt; đổi từng identity field làm ref đổi và không resume binding cũ; T1/T4 |
| R04 | Snapshot scoped và có hash | Hash mismatch, vượt 65536 bytes, invalid type bị từ chối trước invoke; T1 |
| R05 | Validate contract strict | Unknown version/field, null, unsafe integer, NUL, ID sai, prototype và hash sai bị reject; UTF-8 byte boundary gồm tiếng Việt; T1 |
| R06 | Receipt idempotent và conflict rõ | Cùng message ID/canonical envelope ACK reused, không thêm turn; đổi body/reply_to/expiry/recipient trả MESSAGE_CONFLICT; T1/T2/T4 |
| R07 | Correlation không lẫn task | Sequence gap, orphan reply, sender/recipient không đảo, reply thứ hai, participant task khác bị reject; T1/T4 |
| R08 | Positive completion riêng provider/version | Fake fixtures: explicit allowlisted `terminalMarker` trong `profile.allowlistedTerminalMarkers` + `exitCode === 0` + khớp `observedConversationId === binding.conversation_id` và không có `hasTerminalError`; absent/unknown marker hoặc correlation mismatch không success; exit nonzero không success; T3 |
| R09 | Bốn trạng thái độc lập | Error envelope + payload hợp schema ghi `provider: 'failed'`, `schema: 'valid'`, `discussion_result: 'rejected'` (không `available`); ACK chưa invoke giữ `not_started`; `DONE` không đổi `task_acceptance`; T3/T4 |
| R10 | Capability fail closed với identity binding | Verifier evidence thiếu/false/expired hoặc lệch bất kỳ trường định danh nào (`bindingRef`, `provider`, `adapterId`, `adapterVersion`, `conversationId`, `snapshotSha256`, `stage`, hoặc thiếu `liveProfileVerified` khi `mode === 'live'`) bị chặn trước invoke bằng `CAPABILITY_BLOCKED`; fake mode không chuyển G1 verified; T3/T4 |
| R11 | Authority hiện hành | check false/throw trước dispatch: zero invoke; revision đổi trong invoke: response stale, không available; recovery phải recheck; T4 |
| R12 | Durable receipt/intent | Sync failure không ACK; intent sync phải xảy ra trước invoke; failure giữ owner và không spawn; T2/T5 |
| R13 | Single dispatch owner | Hai openJournal cùng root chỉ một thành công; lock cũ/PID không tồn tại vẫn OWNER_BUSY; wrong token không release; T2 |
| R14 | Restart fail closed | Crash ở intent-before-spawn và after-spawn-before-terminal giữ lock, inspect thấy unresolved; không auto replay; torn tail/hash/index sai trả JOURNAL_INVALID, không truncate; T2/T5 |
| R15 | At most one active invocation | Hai dispatch đồng thời khác ID không overlap; cùng ID chỉ invoke một lần; response retry chỉ trả stored view; T4/T5 |
| R16 | Unknown không tự hồi phục | Timeout, overflow, throw sau intent, thiếu terminal marker: unknown, chặn relay, không retry/new attempt/conversation, late success không tự publish; T4/T5 |
| R17 | Recovery cần hai lớp evidence có gắn định danh | Process exit only, provider terminal only, `providerOutcome === 'unknown'`, lệch `bindingRef`/`invocationId` trong recovery evidence, verifier deny hoặc stale authority đều giữ unknown; cả hai hợp lệ chỉ mở khóa cho dispatch explicit mới, không chạy lại ID cũ; T4/T5 |
| R18 | Bounded resource use | Vượt body/snapshot/output, 12 turns, TTL, 8 MiB hoặc 256 events bị chặn (`LIMIT_EXCEEDED` trước intent không làm hỏng journal); output overflow sau spawn là `outcome_unknown`; limits không được tăng ceiling; T1–T5 |
| R19 | Restart/close/rollback rõ | Clean close cho phép reopen khi khớp `bindings`/`snapshot_sha256` đã đăng ký (lệch bị từ chối `CORRELATION_INVALID`); journal có intent dở dang khi mở lại tự khóa ở `outcome_unknown`; close khi unknown trả `OUTCOME_UNKNOWN` và giữ lock; disabled không khởi động workflow cũ; không delete transcript; T2/T4/T5 |
| R20 | API relay dùng được | Fake end-to-end: A question -> B reply -> A question, cùng registered IDs, output server-correlated; inspect giữ task_acceptance not_requested; T4/T5 |
| R21 | Snapshot và journal không là quyền | Payload chứa instruction gọi peer/sửa file không thay ports/policy; message không nhận lease hoặc command flags; T1/T3 |
| R22 | Journal được bảo vệ trong phạm vi host | Symlink/nonregular lock/journal bị reject; owner serialized append; cap checks trước write; T2 |

Không yêu cầu tests offline chứng minh sandbox OS, provider backend hay exactly-once. Mọi case fault phải assert số lần invoke, journal state, lock state và việc không publish result, không chỉ assert exception.

## B. Live qualification — chưa verified

| ID | Điều kiện | Bằng chứng cần lưu |
|---|---|---|
| Q01 / G1 | Hai CLI thực sự resume conversation đúng binding, trao đổi hai chiều | Phiên bản CLI, requested model/effort, observed identity nếu có, ID redacted/correlated, raw terminal fixtures đã loại secret; không gọi model requested là backend verified |
| Q02 / G1 | Capability enforcement thật trước live dispatch | Evidence của trusted host về filesystem/tool restrictions, vùng writable session riêng và journal/checkout không truy cập ghi; plan mode/temp directory không đủ |
| Q03 / G1 | Positive completion profile thật | Provider/version-specific allowlist và correlation rules từ output đáng tin, negative/error fixtures; không mặc định status != error |
| Q04 / G2 live | Fault provider/process thực | Timeout/crash/restart observations, provider outcome hoặc trạng thái blocked; không bắt buộc status-query nếu provider không hỗ trợ; unknown phải còn chặn |
| Q05 | Benchmark có protocol trước chạy | Chọn sample size, paired tasks/model, rubric continuity và thresholds trước chạy; báo p50/p95 wall time, observable token/cost, completion, duplicate dispatch, manual recovery; missing metrics là unavailable |

G0 + deterministic G2 PASS cho phép gọi là implementation accepted có phạm vi, không gọi G1/live G2/benchmark PASS. Không bằng chứng live thì Q01–Q05 giữ NOT VERIFIED hoặc CAPABILITY BLOCKED, không dùng model completion thay evidence.

## C. Future approval

F01: Coding integration không nằm trong MVP. Chỉ thiết kế tiếp sau evidence G0–G2 và explicit approval; bảo toàn execution lease, baseline/artifact validation, QC/integration gates. Không sửa isolated-runner guards hoặc dùng agyPrefixArgs để lách conversation flags.

## Traceability và review

T1: R03–R07, R18, R21. T2: R06, R12–R14, R18–R19, R22. T3: R08–R10, R21. T4: R01, R03, R06–R11, R15–R20. T5: R02, R12–R20 và báo trạng thái Q/F.

- **R01–R22 (Section A — Offline G0 & Deterministic G2):** **PASS** (`node --test --test-concurrency=1 test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js test/dual-discussion-recovery.test.js` -> `tests 21, suites 5, pass 21, fail 0`). Xem bảng đối chiếu đầy đủ trong `docs/dual/discussion-transport/implementation-report.md`.
- **Q01–Q05 (Section B — Live G1, Live G2, Benchmark):** **NOT VERIFIED / CAPABILITY BLOCKED**.
- **F01 (Section C — Coding Integration):** **OUT OF SCOPE / NOT APPROVED**.


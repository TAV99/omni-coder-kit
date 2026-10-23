# Báo cáo thử nghiệm live — Discussion Transport (23/10/2026)

Thực hiện trên máy Linux Muse, branch `codex/dual-wip-checkpoint` (`78e0839`), worktree `omni-dual-exp`; implementers: Codex `gpt-6.1-sol` (effort medium) và AGY `gemini-3.8-flash-high`; controller/verifier: Muse. Các quyết định của repo owner được ghi bên dưới. Kết quả trong báo cáo là các quan sát do controller cung cấp.

## Quyết định của owner

1. **Choreography contract: RELAXED theo lệnh owner.** Sau một reply đã hoàn tất, bất kỳ participant nào cũng có thể mở question tiếp theo cho bên còn lại. Đã sửa nhánh question của `contracts.js validateEnvelope` và error message; mọi invariant khác giữ nguyên.
2. **P1 evidence level: RESOLVED bởi owner.** Live classification có thể bỏ `observedInvocationId`; conversation-id match là đủ.
3. **Commit/push được hoãn** đến khi toàn bộ công việc thử nghiệm hoàn tất; báo cáo này là một phần của việc hoàn tất đó.

## Đã xây dựng

- `live-codex-invoke.js`, `live-agy-invoke.js`: adapters cho mode live và seed helpers.
- `test/dual-discussion-live.test.js`: single relay.
- `test/dual-discussion-live-g2.test.js`.
- `test/dual-discussion-live-benchmark.js`.

## Kết quả do controller quan sát

- **Offline:** 22/22 qua năm discussion suites (21 test gốc + 1 mirrored-follow-up test mới).
- **Live G1:** single relay, một journal, bốn lượt luân phiên A astra / B argon / C astra / D argon. Tất cả provider succeeded, schema valid và có `discussion_result`; `observedConversationId` khớp seeded ids ở mọi lượt. Đã chứng minh continuity hai chiều: astra nhớ tên `getActiveIds` ở C; argon nhớ keyword `GENERIC` ở D. Defect phát hiện và sửa trong thử nghiệm: `codex exec resume` từ chối `-s` vì đây là exec-only flag.
- **Live G2: 3/3.**
  - F1: AGY timeout 50ms → `outcome_unknown`, đúng 1 invocation; dispatch bị chặn khi còn unknown; reconcile bằng recovery evidence đưa outcome về `failed`. Sau khi reconcile QUESTION bị timeout, host phải inject synthetic recovery reply để đáp ứng alternation trước question mới; relay chưa có self-healing synthesis.
  - F2: codex conversation id giả → không có available response, đúng 1 invocation, classification `outcome_unknown`.
  - F3: restart bằng relay instance mới trên cùng `stateDir` replay được turn + response; follow-up thành công; conversation id ổn định qua restart.
- **Benchmark Q05:** protocol được cố định trước khi đo: n=3 paired runs, alternating order, cùng dialogue bốn lượt, models cố định. Relay p50 7619ms so với direct p50 7219ms (overhead +5.55%, threshold ≤ +25%); p95 relay 24658ms so với direct 27370ms. Valid payloads 12/12 ở cả hai mode; duplicate dispatch 0; manual recovery 0. Token usage quan sát được từ cả hai CLI, nhưng AGY chỉ có dữ liệu một phần qua các run.

## Independent adversarial review

AGY, vòng cuối: không phát hiện defect P0/P1 trong code mới. Verdicts: G1 **PASS WITH CAVEATS**, Live G2 **PASS WITH CAVEATS**, Q05 **PASS WITH CAVEATS**.

Các caveat cần tiếp tục theo dõi:

- Host ports (authority/capability) là host-supplied stubs, theo thiết kế qualification harness.
- Recovery quiescence evidence do port cung cấp, chưa được xác minh ở mức OS process.
- Sample nhỏ: G1 N=1 dialogue, Q05 N=12 turns/mode; LLM nondeterminism có thể khiến keyword-count assertion bị flaky.
- Payload sizes thấp hơn nhiều so với `CEILINGS`.
- F2 classification chưa phân biệt misconfiguration với unknown system failure.

## Ánh xạ trạng thái

- **Q01–Q03 (live G1):** đã có evidence, kèm caveat.
- **Q04 (live G2):** đã có evidence, kèm caveat.
- **Q05:** benchmark đã chạy theo protocol cố định trước khi đo.
- **F01 coding integration:** **OUT OF SCOPE / NOT APPROVED**.

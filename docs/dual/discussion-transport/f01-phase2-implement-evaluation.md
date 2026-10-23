# P2-Gói 3 — Đánh giá implement qua persistent AGY conversation

## 1. Câu hỏi và phương pháp

Conversation có thể thực thi implement và tiếp nhận correction dựa vào context cũ, đồng thời giữ được scope, evidence và các ràng buộc authority của dual pipeline hay không?

Harness: [test/dual-phase2-implement-exp.js](../../../test/dual-phase2-implement-exp.js). Chỉ thêm experiment và đánh giá; không sửa product code, không commit. Chạy bằng:

```bash
OMNI_DUAL_LIVE=1 node test/dual-phase2-implement-exp.js /tmp/g3-implement-report.json
```

Không có `OMNI_DUAL_LIVE=1`: in usage, exit 0, không tạo fixture hay gọi provider. Report path phải mới và nằm ngoài fixture root. Mỗi process AGY có timeout 180.000 ms; không retry/fallback khi arm lỗi.

Hai fixture giống nhau được tạo mới tại `/home/hatch/workspace/.exp-briefs/impl-exp/ws-cold/` và `ws-conv/`: `entry.js` re-export `lib/parse.js`, `parseConfig` ban đầu trả `{}`, ba smoke test kiểm parse cặp key/value, trim và bỏ dòng trống/comment. Mỗi arm được `git init`, đưa fixture vào index và lưu tree baseline; không tạo commit. Diff so với tree này bao gồm cả thay đổi đã được worker stage. Input, schema và raw evidence đặt trong `.git/` để không lẫn vào source scope.

Arm A dùng trực tiếp `buildAgyInvocation` và `runProcess` từ [agy-runner.js](../../../lib/dual/agy-runner.js), phase `implement`, model `gemini-3.8-flash-high`, effort `high`. Schema canonical là `toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1')`, đúng cách orchestrator dựng schema implement. Builder giữ nguyên các flag product, kể cả `--dangerously-skip-permissions`. Đây là phép đo worker invocation, không phải toàn bộ orchestrator/lease/QC pipeline. Input mang cùng task content với Arm B và thêm correlation sentinel/schema contract; sentinel 40 số 0 không phải commit thật.

Arm B gọi real `agy -p ... --model gemini-3.8-flash-high --mode accept-edits --output-format json`, không bypass permissions. Turn 1 yêu cầu chỉ sửa `lib/parse.js`. Harness chạy `node --test`, lấy Git diff/status. Trước turn 2, harness thêm test comment có leading spaces, giữ riêng bản test mong đợi; chỉ loại thay đổi test khỏi worker scope khi bytes khớp chính xác bản harness. `fullDiffStat` vẫn giữ toàn bộ diff, kể cả test của harness. Harness cũng chạy test trước correction để biết requirement mới đã được đáp ứng sẵn hay chưa.

Turn 2 dùng `--conversation <id>` với nguyên correction ngắn trong brief; không nhắc lại nội dung file/spec. Nếu turn 1 lỗi hoặc thiếu ID thì không dispatch turn 2. Mỗi turn lưu wallMs, conversation_id, responseEmpty, denied_actions nếu field có mặt, test result và cumulative changedFiles. `conversationStable` chỉ có kết luận khi đo được hai ID. Raw stdout/stderr và invocation lưu ở `.git/arm-a.json`, `.git/turn-1.json`, `.git/turn-2.json` nếu đã thực thi. Một mẫu không đủ để suy ra p50/p95 hay ưu thế hiệu năng; Arm A còn mang schema/permission flags khác Arm B.

## 2. Số đo hai arm

Đã chạy live **đúng một lần**, bắt đầu **2026-10-23T21:23:25.717Z**, Node **v24.22.1**. Process harness exit **1**. Report gốc: `/tmp/g3-implement-report.json` (artifact cục bộ, không đảm bảo tồn tại ngoài phiên).

| Quan sát | Arm A | Arm B |
| --- | --- | --- |
| Failure stage | `setup` | `setup` |
| Error code thực tế | `ENOENT` | `ENOENT` |
| AGY invocation đã dispatch | 0 | 0 |
| wallMs worker | `null` — chưa xác minh | Không có turn — chưa xác minh |
| Smoke test pass/fail | `null` — chưa chạy | Turn 1/2: `null` — chưa chạy |
| changedFiles / scope | `null` — chưa xác minh | `null` — chưa xác minh |
| conversationStable | Không áp dụng | `null` — chưa xác minh |
| responseEmpty / denied_actions | Chưa có CLI JSON | Chưa có CLI JSON |

Lỗi cụ thể của Arm A:

```text
ENOENT: no such file or directory, mkdir '/home/hatch/workspace/.exp-briefs/impl-exp/ws-cold/lib'
```

Arm B:

```text
ENOENT: no such file or directory, mkdir '/home/hatch/workspace/.exp-briefs/impl-exp/ws-conv/lib'
```

Không có số latency worker thật để điền; không thay `null` bằng 0 ms và không gọi test chưa chạy là test fail. Môi trường phiên khai báo writable roots chỉ gồm repo và `/tmp`; fixture root được brief yêu cầu nằm ngoài hai root đó. Quan sát `ENOENT` chưa đủ xác định nguyên nhân filesystem cụ thể, không diễn giải thành một mã `EACCES` chưa thấy. Không thay đường dẫn, sửa permission hay đổi CLI flag để chạy vòng tránh failure. Phiên này chưa xác minh được CLI/model availability hoặc AGY settings pre-authorization.

Kiểm tra offline: script qua `node --check`; nhánh không bật env in usage và exit 0. `dual-contracts.test.js` pass **39/39**. `dual-agy-runner.test.js` pass **8/13**, năm failure liên quan stdout/stderr rỗng hoặc extraction từ output rỗng; `dual-agy-schema-boundary.test.js` fail **1/1** tại assertion stderr thiếu `schema root must specify`. Hai suite này không import script mới. Root cause của subprocess output rỗng **chưa xác minh**; không sửa product ngoài scope để làm xanh checks. Quality gate vì vậy chưa pass toàn bộ. `docs/` đang bị `.gitignore` bỏ qua; file đánh giá tồn tại trên disk, chưa stage/commit.

Các field kết quả chính được giữ nguyên từ report:

```json
{
  "armA": {
    "wallMs": null,
    "testsPass": null,
    "changedFiles": null,
    "failureStage": "setup"
  },
  "armB": {
    "turns": [],
    "testsPassAfterTurn1": null,
    "testsPassAfterTurn2": null,
    "changedFiles": null,
    "conversationStable": null,
    "failureStage": "setup"
  }
}
```

## 3. Khớp kiến trúc

**Lease và workspace binding.** CLI conversation ID không cấp lease của dual authority. Một ID cũ vẫn có thể được CLI nhận dù task đã đổi revision hoặc lease đã hết hạn; tình huống này chưa xác minh live. Product [isolated-runner.js](../../../lib/dual/isolated-runner.js) yêu cầu authorize guard từ authority adapter và kiểm private workspace binding. Muốn dùng conversation phải gắn nó với session/task/plan revision/baseline/lease/attempt và đúng workerRoot; kiểm authority trước dispatch và trong lifecycle, fence conversation cũ khi identity đổi. Cả hai arm của experiment đều không chứng minh được tích hợp lease này.

**Scope guard và isolated runner.** Khi AGY dùng tools để sửa file, tiến trình AGY thực thi write trong workspace của invocation. Conversation không tự gọi scope guard hay tự cung cấp isolation. Ở product, runner/authority điều phối workspace và thu kết quả; [scope-guard.js](../../../lib/dual/scope-guard.js) đo delta và phát hiện file ngoài allowed scope. Nếu nối conversation, host vẫn phải chạy nó bên trong đúng private worker workspace, bảo toàn authorize guard, kiểm scope sau mỗi lượt và trước handoff. Prompt “edit lib/parse.js only” và `accept-edits` không chứng minh được khả năng fence write. Experiment chỉ quan sát Git sau process, không thử adversarial write hoặc tác động ngoài fixture; các khả năng đó **chưa xác minh**.

**Evidence cho QC.** Đổi transport không loại bỏ Git diff: host vẫn có thể lấy changed files/diff và chạy tests độc lập. Đây là khả năng từ cấu trúc harness, chưa có diff live trong lần đo này. EvidenceSchema vẫn là contract implement tại [orchestrator.js](../../../lib/dual/orchestrator.js), kèm correlation task/baseline. Conversation JSON, ID ổn định hay câu trả lời “done” không thay thế validated evidence/hashes và independent QC. Arm A yêu cầu schema nhưng harness này không chạy toàn bộ normalization/recovery/acceptance; Arm B chưa tạo product EvidenceSchema contract. Không suy ra hai đường có evidence tương đương chỉ từ output CLI.

**Recovery và `outcome_unknown`.** Product implement có `tryRecoverPhase` dựa trên raw artifact và correlation trước khi chạy worker lại. Discussion [relay.js](../../../lib/dual/discussion/relay.js) giữ trạng thái `outcome_unknown` và chặn release owner lock khi outcome chưa biết. Nếu conversation chết sau khi đã write nhưng trước khi trả JSON, việc thiếu response không chứng minh “chưa sửa file”. Host phải giữ evidence và khóa, xác minh process đã quiescent, đọc workspace delta, đối chiếu invocation/operation identity rồi reconcile outcome. Không tự cold fallback hoặc replay correction khi chưa rõ write đã xảy ra. Harness chỉ lưu kết quả process và không tự retry; chưa mô phỏng crash, chưa chứng minh recovery idempotent hay fencing sau timeout. Các điểm này **chưa xác minh**.

**Context drift qua correction.** Turn 2 cố ý dựa vào context turn 1; test mới phải loại được key `#comment` cả khi có space/tab phía trước. Kiểm equality ID là một bằng chứng continuity cần thiết, không chứng minh model hiểu đúng revision. Model có thể đã xử lý leading-space comments ngay turn 1; khi đó turn 2 pass không chứng minh đã sửa nhờ context, nên cần xem cả test trước turn 2 và diff. Giới hạn context, compact history, nhiều vòng QC, đổi scope/task hoặc stale instructions đều **chưa xác minh** trong mẫu này.

## 4. Rủi ro và điều kiện tiên quyết

- Chạy lại trong môi trường ghi được đúng fixture root và đã pre-authorize hai fixture trong AGY settings; xác minh CLI/model thực tế mà không bypass permissions cho Arm B.
- Bổ sung product binding và lease fencing cho từng invocation; conversation không được tái sử dụng xuyên task/revision/attempt khi binding không khớp.
- Giữ isolated runner làm chủ process/workspace lifecycle, scope guard làm chủ measured delta, QC làm chủ test/evidence; không giao các quyết định này cho lịch sử hội thoại.
- Có durable dispatch/result evidence và recovery reconcile cho crash, timeout, CLI JSON rỗng, denied actions, ID mismatch; không fallback khi outcome chưa biết.
- Giới hạn số lượt/thời gian/context, truyền correction gắn revision và kiểm regression sau từng lượt. Tính đúng dưới nhiều lượt sửa vẫn chưa xác minh.

## 5. KHUYẾN NGHỊ: reject

**Reject việc áp dụng persistent conversation cho implement ở thời điểm đánh giá này.** Không có arm nào vượt setup; chưa có bằng chứng chức năng hoặc tốc độ để chọn adopt hay hybrid. Đây là quyết định theo evidence hiện có, không phải kết luận conversation không thể sửa file. Giữ đường implement hiện tại; chưa bật conversation cho vòng sửa sau QC.

Ngưỡng đánh giá lại đề xuất (chưa đạt): chạy thành công ít nhất **10 cặp fresh workspace**, mỗi conversation có đủ hai lượt; **100%** smoke/regression pass, ID ổn định, không response rỗng/denied action chưa xử lý, **0** worker write ngoài scope. Phải có trường hợp test mới fail trước correction rồi pass sau correction để chứng minh năng lực sửa. Sau đó đo riêng nhiều vòng correction với context tối giản, chứng minh binding đúng và fence được lease hết hạn/revision sai; fault injection sau-write-trước-response phải dẫn tới outcome_unknown/reconcile, không duplicate dispatch hoặc unknown tồn đọng. Chỉ cân nhắc hybrid nếu tất cả correctness/recovery gates đạt và median correction wallMs tiết kiệm **ít nhất 20%** so với cold correction cùng task/model/quyền/schema. Harness hiện tại chưa đo cold correction; phải bổ sung phép đo đó trong scope đánh giá sau, không suy ra từ Arm A initial implement.

## 6. Bổ sung — số đo thật (chạy từ shell Muse, 24/10/2026)

Lần đo trong phiên Codex thất bại vì fixture root nằm ngoài writable roots của
sandbox Codex (mọi metric "chưa xác minh"). Chạy lại từ shell Muse với cùng script:

**Arm A (cold, invocation sản phẩm)** — 2 mẫu, nhất quán:
- Mẫu 1: wall 124,7s, tests **3/3 pass**, changedFiles = [lib/parse.js] (đúng scope).
- Mẫu 2: wall 99,8s, tests **3/3 pass**, changedFiles = [lib/parse.js].

**Arm B (conversation, brief lỏng như brief gốc)** — 2 lần chạy, cùng một chữ ký lỗi:
- Cả hai lượt (7,7s và 8,1s; lượt sửa 6,5–19,6s) đều **response rỗng, 0 file thay đổi**,
  usage ghi đúng 1 RunCommand bị từ chối. Conversation id ổn định (continuity OK)
  nhưng model mở đầu bằng lệnh shell, bị chặn quyền headless, rồi bỏ lượt —
  không hề thử write_file dù đã được cấp quyền theo path.

**Arm B' (probe bổ sung — brief ghim công cụ: "chỉ dùng write_file, không chạy shell")**:
- 1 lượt, 115s, response đầy đủ, lib/parse.js được viết đúng (tests của fixture đạt),
  giữ nguyên export style. Conversation implement **làm được** khi brief ghim công cụ.

### Kết luận đo được
- Đường lạnh thắng ở độ tin cậy không cần ghim brief: machinery của sản phẩm
  (input file + schema + invocation) tự ràng buộc worker — 2/2 đạt, scope sạch.
- Conversation implement khả thi nhưng **mong manh theo kỷ luật prompt**: brief không
  ghim công cụ là sập ngay tại hành động bị từ chối đầu tiên (response rỗng, mất lượt).
- Cộng với các khoảng trống kiến trúc ở mục 3 (không lease/binding, không scope-guard,
  không EvidenceSchema contract, recovery khi chết giữa chừng lúc đang write chưa định),
  **KHUYẾN NGHỊ giữ nguyên: REJECT ở thời điểm này** — implement ở lại isolated-runner.
- Ngưỡng đánh giá lại: host gắn conversation với lease/baseline như discussion binding;
  brief implement được ghim công cụ + kiểm scope sau mỗi lượt; và một benchmark implement
  chốt trước cho thấy tỉ lệ đạt ≥ đường lạnh trên cùng fixture suite.

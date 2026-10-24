# F01 Phase 3 — Báo cáo review đối kháng toàn diện (Full Review AGY)

- **Ngày review:** 2026-10-24
- **Reviewer:** AGY (Gemini 3.8 Flash High) — Vai trò: **REVIEWER ĐỐI KHÁNG**
- **Worktree:** `/home/hatch/workspace/projects/omni-dual-exp`, nhánh `codex/dual-live-experiment`
- **Phạm vi đối chiếu:** Toàn bộ diff từ `4125c1b` (cuối Phase 2) tới HEAD `c6dbd96` (44 file, +3880/−450)
- **Kỷ luật vận hành:** AGY chỉ đọc file và ghi duy nhất 01 file báo cáo này. Tuyệt đối không chạy shell command, không sửa code production, không sửa test, không commit.

---

## 1. Verdict tổng

### **ACCEPT WITH FIXES**

### Tóm tắt lý do:
1. **Production Code ĐẠT CHUẨN XUẤT SẮC (Zero P0):**
   - Ngăn chặn triệt để đối thoại lạnh ở seam scout/review (`DUAL_DISCUSSION_REQUIRED` ném dạng precondition trước mọi `store.append`, không `phase.started`, không `phase.failed`, không ghi failure artifact, không gây brick task qua `findTerminalPhaseFailure`).
   - Khóa kín mọi entrypoint production: daemon default factory, executable `bin/omni-daemon.js`, isolated child chain, standalone CLI. Không còn bất kỳ đường production nào rơi xuống cold processRunner cho scout/review.
   - Isolated discussion đáp ứng hoàn hảo thiết kế Phương án A: tách bạch 3 identity W/B/D, hệ thống guard 3 chốt (Seed Wrapper + Prespawn Callback + Relay Facade) bao phủ cả turn, nudge nội bộ và bounded process probe.
   - Từ điển CLI bao phủ 100% mã `DUAL_DISCUSSION_*` và `DUAL_ISOLATED_DISCUSSION_*`, thông điệp chuẩn xác, không khuyên tắt flag để chạy lạnh.
   - Benchmark OLD được retire fail-closed dứt khoát trước mọi provider I/O; implement experiment và diagnostics lịch sử được bảo toàn.
   - Không có thay đổi hành vi ngoài phạm vi: implement retry/timeout/evidence, capability preflight, raw historical recovery, `saveAttemptEvidence` được giữ nguyên vẹn.

2. **Lý do WITH FIXES (0 P0, 2 P1, 2 P2):**
   - **P1-01:** Suite `test/dual-daemon-orchestrator.test.js` (53 scenarios) chưa hoàn tất di trú sau khi Codex chạm hạn mức 5H ở Gói 2c-ii, hiện trạng source và nhật ký vẫn ghi nhận nợ 20 pass / 33 fail (tập case fail giữ nguyên từ trước Gói 2a). Cần Muse chạy kiểm chứng và dọn dứt điểm nợ test này.
   - **P1-02:** Helper stub `test/helpers/dual-discussion-stub.js:144` bị hardcode attempt `1` (`raw/${phase}.1.input.md`), gây rủi ro sai lệch hoặc crash khi chạy test có kịch bản retry / multi-attempt.

---

## 2. Kết luận chi tiết từng giả thuyết (H1 – H8)

### H1: `DUAL_DISCUSSION_REQUIRED` ném trước mọi `store.append` ở seam scout/review
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - `lib/dual/orchestrator.js:820-828`:
    ```javascript
    if (['scout', 'review'].includes(phase)) {
        if (options.discussion?.enabled !== true) {
            throw new DualOrchestratorError('DUAL_DISCUSSION_REQUIRED',
                `The ${phase} phase requires discussion transport; the cold-start path has been removed`);
        }
        ({ inputPath, schemaPath } = prepareInputArtifacts());
        store.append({ type: 'phase.started', phase, attempt });
    ```
  - `lib/dual/orchestrator.js:1345-1353` (scout) & `lib/dual/orchestrator.js:1795-1804` (review): `prepareInputArtifacts` được truyền dạng callback hoãn thi hành; không ghi file immutable vào `raw/` trước khi discussion được xác nhận.
  - `lib/dual/state-store.js:321-325`: Hàm `store.nextAttempt(phase)` là hàm thuần đọc (`replayCurrent(readRawRecords())`), tuyệt đối không gọi `store.append`.
  - `lib/dual/orchestrator.js:829-903`: Throw `DUAL_DISCUSSION_REQUIRED` nằm ngoài khối `try { ... } catch (err)`, do đó không bị bắt bởi catch block ghi `phase.failed` non-retryable hay tạo `.failure.json`.
  - `lib/dual/orchestrator.js:1125-1137`: Vì không có sự kiện `phase.failed` non-retryable nào được ghi vào `events.ndjson`, hàm `findTerminalPhaseFailure` không bị kích hoạt trong các lần chạy sau, bảo toàn task không bị brick vĩnh viễn khi gặp lỗi cấu hình.

---

### H2: Không còn đường production nào dispatch đối thoại lạnh cho scout/review
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - `lib/dual/orchestrator.js:820-908`: Khối `if (['scout', 'review'].includes(phase))` bắt buộc đi qua discussion hoặc throw terminal/precondition error. Không có bất kỳ đường fall-through nào xuống vòng lặp lạnh `while (attempt <= MAX_AGY_TECHNICAL_ATTEMPTS)` tại dòng 908 cho hai phase này.
  - `lib/dual/daemon-server.js:442-446`, `678-690`: Default factory tự động kích hoạt discussion khi env `unset` hoặc `'on'`. Khi env `'0'`, `'false'`, `'off'`, `'no'` hoặc invalid, `discussionHost` là `null`, `createOrchestratorAdapter` không nhận `discussion`, dẫn đến orchestrator ném `DUAL_DISCUSSION_REQUIRED` (fail-closed, không fallback lạnh).
  - `bin/omni-daemon.js:37-47`, `77-82`: Executable sản xuất sử dụng `createExecutableOrchestrator`, kết nối `createDaemonDiscussionHost` qua env gate, truyền `daemonDiscussionOptions(discussionHost)` vào adapter và đóng `closeAll` an toàn ở lifecycle shutdown.
  - `lib/dual/isolated-runner.js:214-237`, `264`, `298`: Fresh isolated task chỉ gọi `scout` và `review` qua orchestrator private có child discussion. Nếu discussion không bật, ném `DUAL_DISCUSSION_REQUIRED`; nếu bật nhưng thiếu factory, ném `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED`. Wrapper `processRunner` (dòng 241–253) chỉ bao bọc `implement`.
  - `lib/commands/dual.js:324-325`: Standalone CLI chỉ truyền `{ enabled: env === 'on' }` mà không cấp resolver. Khi off/unset → ném `DUAL_DISCUSSION_REQUIRED`; khi on → ném `DUAL_DISCUSSION_RESOLVER_REQUIRED`. Cả hai đều fail-closed tại seam.
  - Test seam: `test/helpers/dual-discussion-stub.js:155-159` cài đặt assertion chủ động chặn đứng nếu `processRunner` bị gọi cho phase không phải `implement`.

---

### H3: Isolated child tách identity W/B/D đúng thiết kế; guard 3 lớp phủ cả seed I/O và nudge/repair nội bộ adapter; phân loại lỗi FACTORY_REQUIRED/IDENTITY_INVALID đúng
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - **Tách bạch 3 Identity (W / B / D):**
    - `W`: Canonical workerRoot chuẩn hóa qua `fs.realpathSync.native()` (`lib/dual/discussion/host-resolver.js:18-21`, `:115`, `lib/dual/isolated-runner.js:69`, `lib/dual/daemon-server.js:484-487`).
    - `B`: Worker snapshot identity `context.workerBaselineId = initialSnapshot.identity.id` (`lib/dual/discussion/host-resolver.js:126`, `:242`, `lib/dual/isolated-runner.js:220`).
    - `D`: Discussion snapshot SHA256 `sha256Utf8(text)` (`lib/dual/discussion/host-resolver.js:129-131`, `:240-246`, `:286`).
    - `lib/dual/discussion/host-resolver.js:166`: `childAuthorityReader` kiểm tra `expectedSnapshotSha256` dựa trên `snapshotSha256` (D), tách biệt hoàn toàn khỏi hash file của worker baseline hay daemon baseline. Manifest `.manifest.json` ghi nhận riêng rẽ `discussion_snapshot_sha256`, `workspace_baseline_id` (B) và `worker_root` (W) (dòng 307–311).
  - **Hệ thống Guard 3 chốt:**
    - *Chốt 1 — Seed Guard Wrapper:* `lib/dual/isolated-runner.js:223` truyền `guards: { check, wrapSeed: bracket }`; `lib/dual/discussion/host-resolver.js:249-269` (`bracketSeed`) bọc trực tiếp seed của Codex và AGY bằng `await check()` trước và trong `finally`.
    - *Chốt 2 — Prespawn Guard Callback:* `lib/dual/discussion/live-agy-invoke.js:81`, `:363-364`, `:396`, `:406-410` và `live-codex-invoke.js:73`, `:312-316`: `prespawnGuard` được await trước **mọi** spawn tiến trình con. Trong `live-agy-invoke.js:364`, hàm `call()` nội bộ bọc cả turn đầu (`phase: 'turn'`) lẫn lệnh nhắc sửa nội bộ (`phase: 'nudge'`). Tương tự, `lib/dual/capability-preflight.js:82-85` await `prespawnGuard` trước mọi probe tiến trình con.
    - *Chốt 3 — Relay Facade:* `lib/dual/isolated-runner.js:230-237`: bọc 4 phương thức ranh giới của relay (`receive`, `dispatch`, `reconcile`, `inspect`) bằng hàm `bracket` (pre-check + finally post-check).
  - **Phân loại lỗi chuẩn:**
    - `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED`: Khai báo `error.category = 'PRECONDITION'`, `error.kind = 'PRECONDITION'` (`lib/dual/isolated-runner.js:18`), ném tại dòng 216 trước khi gọi bất kỳ phase nào của orchestrator, không ghi `phase.failed`.
    - `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID`: Khai báo `error.category = 'TERMINAL'`, `error.kind = 'TERMINAL'` (`lib/dual/isolated-runner.js:19`, `lib/dual/discussion/host-resolver.js:12-16`), ném lập tức khi phát hiện mismatch giữa workerRoot, baseline, contract hoặc reference (các dòng 131, 177, 181, 187, 226).

---

### H4: Từ điển CLI bao phủ đủ mọi mã discussion/isolated trong `lib/`; thông điệp không khuyên tắt flag để chạy lạnh
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - `lib/commands/dual.js:40-46` định nghĩa đầy đủ 7 mã tiếng Việt:
    1. `DUAL_DISCUSSION_REQUIRED`: "Scout/review cần discussion transport do daemon cấp. Hãy chạy qua authority daemon; CLI độc lập không có discussion host, tắt discussion không khôi phục đường chạy lạnh."
    2. `DUAL_DISCUSSION_RESOLVER_REQUIRED`: "Thiếu discussion session resolver. Hãy chạy scout/review qua authority daemon; CLI độc lập không có discussion host."
    3. `DUAL_DISCUSSION_SESSION_DISABLED`: "Discussion session đã tắt nên scout/review bị chặn. Hãy bật discussion và chạy qua authority daemon; không có đường chạy lạnh."
    4. `DUAL_DISCUSSION_BINDINGS_REQUIRED`: "Discussion session thiếu binding Astra hoặc Argon. Hãy kiểm tra cấu hình discussion host của daemon trước khi chạy scout/review."
    5. `DUAL_DISCUSSION_FAILED`: "Pha đối thoại qua discussion transport thất bại. Hãy kiểm tra evidence và trạng thái discussion trên daemon trước khi xử lý tiếp."
    6. `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED`: "Thiếu factory cấp discussion cho isolated execution. Hãy chạy qua authority daemon có discussion host; tắt discussion không khôi phục đường chạy lạnh."
    7. `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID`: "Định danh discussion không khớp isolated execution. Hãy kiểm tra evidence và binding workspace/task trên daemon; không tái dùng session khác."
  - Quét đối chiếu toàn bộ `lib/`: Không còn bất kỳ mã `DUAL_DISCUSSION_*` hoặc `DUAL_ISOLATED_DISCUSSION_*` nào khác xuất hiện trong engine mà thiếu trong từ điển.
  - Ngữ nghĩa thông điệp: Toàn bộ thông điệp hướng người dùng chạy qua daemon, khẳng định việc tắt flag không thể khôi phục đường lạnh.

---

### H5: Benchmark OLD retire trước provider I/O; diagnostics suite và implement experiment không bị phá; không còn hidden cold option
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - `test/dual-phase2-benchmark.js:70-76`: Hàm `rejectRetiredMode(config.mode)` ném lỗi `BENCHMARK_OLD_RETIRED` ngay lập tức trước toàn bộ các câu lệnh `require()` module sản xuất và trước mọi kết nối provider.
  - `test/dual-phase2-benchmark.js:496-503`: Trong `main()`, bất kỳ tham số `--modes=` nào chứa `OLD` hoặc chạy live mặc định (cặp OLD/NEW lịch sử) đều bị từ chối ngay trước khi tạo file kết quả hay fork worker con.
  - `test/dual-phase2-benchmark-retirement.test.js:1-78`: Bộ 10 test offline chứng minh chế độ OLD bị chặn đứng ở mọi biến thể tham số (`--modes=OLD`, `--modes=OLD,NEW`, `--modes=OLD/NEW`, default live, worker message trực tiếp) với 0 lượt gọi filesystem, 0 tiến trình con và 0 import production.
  - `test/dual-phase2-implement-exp.js`: Giữ nguyên vẹn, không nằm trong diff Phase 3, bảo toàn bài đo nhánh implement lạnh.
  - `test/dual-discussion-benchmark-diagnostics.test.js`: Giữ nguyên vẹn, tương thích hoàn toàn với diagnostic offline.
  - Không tồn tại hidden cold option hay cờ lách luật nào trong code Phase 3 để ép scout/review chạy lạnh.

---

### H6: Mọi khẳng định trong README/docs/runbook mới đều đúng với code
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - `README.md:144-150`: Mô tả chính xác việc phân tách transport (scout/review discussion-only, implement process dưới lease/scope guard); daemon mặc định bật discussion ở cả default factory và `bin/omni-daemon.js`; cờ off/invalid fail-closed; CLI độc lập không có host; library yêu cầu `enabled === true`.
  - `docs/dual-safe-recovery.md:3`: Chỉ bổ sung pointer liên kết sang runbook discussion; toàn bộ 86 dòng quy định về async validator (mutation fence, ledger byte preservation, runId, Job Object, attestation replay) giữ nguyên 100% ngữ nghĩa gốc.
  - `docs/dual/discussion-transport/f01-discussion-recovery-runbook.md:90-100`: Nêu bật ranh giới kỹ thuật: Unknown tại orchestrator ghi `phase.failed` non-retryable; reconcile relay không tự xóa sự kiện này; `relay.close()` giữ lock khi unknown; và khẳng định rõ ràng: *"CHƯA có workflow đã xác minh restart → reclaim owner → tiếp tục terminal phase, cũng chưa có lệnh CLI/RPC resume/reconcile end-to-end được runbook này chứng nhận."*
  - `docs/dual/discussion-transport/f01-integration-design.md:3-13` & `f01-phase2-benchmark-report.md:3-14`: Bổ sung chú thích snapshot lịch sử và retirement ở đầu file mà không sửa đổi bất kỳ số liệu thực nghiệm hay bảng đo Phase 2 nào.

---

### H7: Không có thay đổi behavior production ngoài phạm vi
- **Kết luận:** **TRUE**
- **Bằng chứng file:dòng:**
  - **Implement retry/timeout/evidence:** `lib/dual/orchestrator.js:908-991` duy trì đầy đủ vòng lặp kỹ thuật tối đa 3 attempts (`MAX_AGY_TECHNICAL_ATTEMPTS`), kiểm tra hợp đồng `buildRegisteredTaskBrief` trước mỗi retry, phân loại lỗi spawn/network, sinh `retryCorrectionHint`, xử lý `DUAL_AGY_TIMEOUT` (mặc định 1.230.000 ms), chuẩn hóa evidence và lưu trữ artifact.
  - **Capability precheck:** `lib/dual/orchestrator.js:785-815` giữ nguyên khối tiền kiểm: ưu tiên preflight đã hoàn thành, kiểm tra bằng chứng có thẩm quyền `authoritativeCapabilityEvidence` (ném `DUAL_PREFLIGHT_AUTHORITY_INVALID` nếu sai lệch), hoặc probe qua `probeStandaloneCapability`. Hợp đồng `AttemptMetaSchema` (`lib/dual/contracts.js:355-364`) tiếp tục bắt buộc `agy_version` là string không rỗng.
  - **Đọc raw lịch sử:** `lib/dual/orchestrator.js:1017-1053` (`tryRecoverPhase`) nhận diện artifact discussion qua `meta?.transport === 'discussion'` và bọc vào `{ structured_output }`, đồng thời giữ nguyên nhánh đọc JSON thô đối với artifact lạnh cũ (`:1036`).
  - **Lưu trữ bằng chứng attempt:** `lib/dual/orchestrator.js:735-768` (`saveAttemptEvidence`) duy trì việc ghi 3 file raw (`.stdout.json`, `.stderr.txt`, `.meta.json`) với đầy đủ metadata bảo mật (băm SHA-256 input/schema, thời gian bắt đầu/kết thúc, durationMs, exitCode, timedOut, cwd, shell=false, redactedArgs và transportEvidence).

---

### H8: Test di trú không che mất coverage cũ bằng stub/fake
- **Kết luận:** **PARTLY**
- **Bằng chứng file:dòng & Phân tích đối kháng:**
  - *Điểm tốt:* Các suite di trú đã tích hợp assertion chặt chẽ để bảo đảm không có hồi quy chạy lạnh lén lút: `test/helpers/dual-discussion-stub.js:156-157` assert `processRunner` chỉ được gọi khi có chuỗi `'implement phase'`; `test/dual-isolated-runner.test.js:1107-1117` đếm rõ 2 turns discussion và 1 call implement; `test/dual-e2e.test.js:242-253` kiểm tra standalone review fail-closed và không làm bẩn `events.ndjson`.
  - *Chỗ stub/fake làm giảm khả năng phát hiện hồi quy hoặc còn nợ di trú:*
    1. **Nợ kỹ thuật 33 failing tests trong `test/dual-daemon-orchestrator.test.js`:**
       Theo nhật ký `docs/dual/discussion-transport/f01-program-status.md:161-164` và `:262-263`, suite daemon-orchestrator gồm 53 scenarios vẫn đang ở trạng thái **20 pass / 33 fail**. Dù đầu file đã được chêm helper `withDiscussion`, 33 scenarios (vốn dựa trên module-level opt-out env `'0'` từ trước Phase 3) chưa được di trú hoàn tất do Codex chạm giới hạn hạn mức 5H trong Gói 2c-ii. Các kịch bản này hiện chưa thể chứng minh tính đúng đắn trên nhánh discussion mới.
    2. **Hardcoded attempt `1` trong `test/helpers/dual-discussion-stub.js:144`:**
       `const input = `.omni/codex-gemini/runs/${taskId}/raw/${phase}.1.input.md`;`
       Helper dùng chung này cố định attempt `1`. Nếu có test case mô phỏng retry ở scout/review (attempt 2 hoặc 3), stub sẽ đọc sai file của attempt 1 hoặc throw lỗi nếu attempt 1 không tồn tại, che khuất hành vi xử lý đa attempt thực tế của orchestrator.
    3. **Relay Facade Stub bỏ qua logic `DiscussionRelay` thật:**
       Trong `test/helpers/dual-discussion-stub.js:48-71`, đối tượng `relay` là một stub tối giản, trực tiếp gọi `turn()` và trả response ngẫu nhiên. Mặc dù các suite chuyên biệt `test/dual-discussion-*.test.js` đã kiểm thử relay thật, việc các suite tích hợp cấp cao (daemon, isolated, handoff, finalization) chạy hoàn toàn qua stub này làm mất khả năng phát hiện các lỗi tích hợp sâu liên quan đến file-lock contention của journal, hash-chain desync, hoặc timeout thực tế của relay trong luồng daemon/isolated.
    4. **Proxy `localFs` trong `scriptPayload` hẹp (`test/helpers/dual-discussion-stub.js:115-121`):**
       Chỉ bọc 5 phương thức fs đồng bộ. Nếu fake script gọi `statSync`, `lstatSync`, `appendFileSync` hoặc các hàm fs khác, đường dẫn tương đối sẽ resolve theo tiến trình Node host thay vì thư mục cách ly của worker.

---

## 3. Danh sách Findings đối kháng (P0 / P1 / P2)

### P0 (Blocker / Data Loss / Security Hole / Task Bricking)
*Không có finding P0 nào.* Toàn bộ cơ chế an toàn fail-closed và bảo vệ task state đã được triển khai nghiêm ngặt theo đúng thiết kế đã duyệt.

---

### P1 (Significant Risk / Test Regression Debt / Incomplete Migration)

#### Finding P1-01: Nợ di trú 33 case fail trong suite `test/dual-daemon-orchestrator.test.js`
- **File:Dòng:** `test/dual-daemon-orchestrator.test.js:1-8` đối chiếu `docs/dual/discussion-transport/f01-program-status.md:161-164`, `:262-263`.
- **Cơ chế lỗi:** Suite gốc gồm 53 scenarios đặt `OMNI_DUAL_DISCUSSION_ENABLED = '0'` ở cấp module. Khi Gói 1 chuyển scout thành discussion-only, 33 scenarios chạy task thật bị fail do thiếu discussion resolver. Trong Gói 2c-ii, Codex đã gỡ biến môi trường ở đầu file và bọc `createOrchestratorAdapter` qua `withDiscussion`, nhưng do chạm hạn mức 5H nên chưa hoàn tất việc chạy và xác nhận xanh toàn bộ suite. Nhật ký program-status tại commit cuối vẫn ghi nhận: *“daemon-orchestrator giữ nguyên 20/33 (delta 0)”*.
- **Tác động:** 33 kịch bản tích hợp của daemon (bao gồm kiểm tra snapshot, authority lease lifecycle, QC verification) chưa được xác nhận pass độc lập ở shell cấp cao nhất, tạo ra khoảng trống kiểm chứng đối với các luồng phối hợp daemon phức tạp.
- **Cách sửa gợi ý:** Muse chạy kiểm chứng lệnh `node --test test/dual-daemon-orchestrator.test.js` ở shell cấp cao nhất; đối với các scenario tự tạo adapter riêng hoặc inject orchestrator fixture đặc thù, bổ sung discussion stub phù hợp để đưa toàn bộ 53/53 scenarios về trạng thái PASS.

#### Finding P1-02: Hardcoded attempt `1` trong `dual-discussion-stub.js`
- **File:Dòng:** `test/helpers/dual-discussion-stub.js:144`:
  ```javascript
  const input = `.omni/codex-gemini/runs/${taskId}/raw/${phase}.1.input.md`;
  ```
- **Cơ chế lỗi:** Khi `withDiscussion` điều hướng turn đối thoại, nó giả định đường dẫn file input luôn là attempt 1.
- **Tác động:** Nếu một test case kiểm thử kịch bản retry hoặc correction ở giai đoạn scout/review khiến attempt tăng lên 2 hoặc 3, stub sẽ đọc nhầm input cũ của attempt 1 (nếu file còn) hoặc throw lỗi ENOENT, làm sai lệch kết quả kiểm thử và che giấu lỗi hồi quy ở các lần attempt sau.
- **Cách sửa gợi ý:** Cập nhật helper để lấy attempt động từ tham số context của turn hoặc quét file `raw/${phase}.*.input.md` có số attempt tương ứng với lần chạy hiện tại.

---

### P2 (Minor / Edge Case / Technical Debt)

#### Finding P2-01: Proxy `localFs` trong `scriptPayload` chỉ bọc tập con phương thức fs
- **File:Dòng:** `test/helpers/dual-discussion-stub.js:115-121`:
  ```javascript
  const localFs = new Proxy(fs, { get(target, name) {
      if (['readFileSync', 'writeFileSync', 'mkdirSync', 'existsSync', 'readdirSync'].includes(name)) { ... }
  ```
- **Cơ chế lỗi:** Chỉ có 5 hàm fs được định tuyến đường dẫn tương đối theo `invocation.cwd`. Các hàm khác như `statSync`, `lstatSync`, `appendFileSync`, `copyFileSync` rơi vào `fs` gốc của Node process.
- **Tác động:** Nếu fixture fake-agy trong tương lai gọi các hàm ngoài allowlist 5 hàm trên, thao tác file có thể bị rò ra ngoài thư mục worker của test.
- **Cách sửa gợi ý:** Bổ sung `statSync`, `lstatSync`, `appendFileSync` vào danh sách chuyển hướng đường dẫn của proxy `localFs`.

#### Finding P2-02: Rủi ro orphaned marker file khi crash sớm trước khi seed hoàn tất
- **File:Dòng:** `lib/dual/discussion/host-resolver.js:246-247`:
  ```javascript
  try { fs.writeFileSync(directory + '.execution.json', text, { flag: 'wx' }); }
  catch { throw identityError('Isolated generation already exists; recovery is required before reseeding'); }
  ```
- **Cơ chế lỗi:** Cờ `wx` bảo đảm tính duy nhất của generation. Tuy nhiên, nếu tiến trình daemon bị SIGKILL ngay sau khi ghi file `.execution.json` nhưng trước khi kịp seed hoặc ghi `.manifest.json`, lần chạy sau với cùng `executionKey` sẽ bị từ chối vĩnh viễn với lỗi `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID`.
- **Tác động:** Không gây sai lệch dữ liệu nhưng đòi hỏi cơ chế recovery/cleanup thủ công nếu xảy ra crash ở micro-second này.
- **Cách sửa gợi ý:** Đưa việc dọn dẹp các marker file mồ côi (`.execution.json` không có `.manifest.json` và không có active process) vào tài liệu nợ kỹ thuật sau Phase 3 (retention & GC subsystem).

---

## 4. Hướng dẫn kiểm chứng dành cho Muse

Muse thực hiện các bước kiểm chứng độc lập ở shell cấp cao nhất (không sandbox Codex) để chốt nghiệm thu:

1. **Kiểm tra suite daemon-orchestrator (Finding P1-01):**
   ```bash
   node --test test/dual-daemon-orchestrator.test.js
   ```
   *Xác định rõ:* Suite hiện đạt bao nhiêu pass / fail trên worktree HEAD? Nếu còn 33 fail như ghi nhận trong `f01-program-status.md`, hoàn thiện nốt việc di trú cho các scenario này.

2. **Kiểm tra toàn bộ các cổng test discussion, isolated và CLI:**
   ```bash
   node --test test/dual-discussion-*.test.js
   node --test test/dual-isolated-runner.test.js test/dual-daemon-host-wiring.test.js test/dual-cli.test.js test/dual-e2e.test.js
   node --test test/dual-phase2-benchmark-retirement.test.js
   ```

3. **Chạy nghiệm thu live qua executable thật:**
   Khởi động `bin/omni-daemon.js --workspace <dir>` và chạy 1 task thật để kiểm chứng wiring `createExecutableOrchestrator` hoạt động ổn định với live discussion host.

---

## 5. Tóm tắt gửi Muse

- **Verdict:** **ACCEPT WITH FIXES**
- **Số lượng Findings:** **0 P0 | 2 P1 | 2 P2**
  - **P0:** 0 (Code production, seam precondition, isolated 3 chốt, CLI error messages và benchmark retirement đều hoàn hảo).
  - **P1:** 2 (P1-01: Nợ di trú 33 case fail trong `test/dual-daemon-orchestrator.test.js` cần kiểm chứng và đóng dứt điểm; P1-02: Hardcoded attempt `1` trong `dual-discussion-stub.js:144`).
  - **P2:** 2 (P2-01: Proxy `localFs` trong `scriptPayload` hẹp; P2-02: Rủi ro orphaned `.execution.json` khi crash sớm).
